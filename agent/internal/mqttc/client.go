// Package mqttc owns the agent's broker connection.
package mqttc

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"os"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"github.com/zenstier/agent/internal/buildinfo"
	"github.com/zenstier/agent/internal/config"
	"github.com/zenstier/agent/internal/metrics"
	"github.com/zenstier/agent/internal/osinfo"
	"github.com/zenstier/agent/internal/protocol"
)

type Client struct {
	mqtt      mqtt.Client
	cfg       *config.Config
	log       *slog.Logger
	sessionID string
	startedAt time.Time

	// Guards the broadcast subscription set, which the server can change at
	// runtime via an update_groups command.
	groupsMu  sync.Mutex
	groups    []string
	onCommand mqtt.MessageHandler
}

// New builds the broker client. onCommand is invoked for every inbound command
// message and must not block.
func New(
	cfg *config.Config,
	onCommand mqtt.MessageHandler,
	log *slog.Logger,
) (*Client, error) {
	tlsCfg := &tls.Config{
		MinVersion: tls.VersionTLS12,
		ServerName: cfg.MQTT.Host,
	}
	if cfg.MQTT.CAFile != "" {
		pem, err := os.ReadFile(cfg.MQTT.CAFile)
		if err != nil {
			return nil, fmt.Errorf("read CA: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("ca file contains no usable certificate")
		}
		tlsCfg.RootCAs = pool
	}

	c := &Client{
		cfg:       cfg,
		log:       log,
		sessionID: randomHex(16),
		startedAt: time.Now().UTC(),
		groups:    append([]string(nil), cfg.Groups...),
		onCommand: onCommand,
	}

	statusTopic := protocol.StatusTopic(cfg.DeviceID)
	will, _ := json.Marshal(protocol.Status{
		V:            protocol.Version,
		State:        "offline",
		DeviceID:     cfg.DeviceID,
		SessionID:    c.sessionID,
		AgentVersion: buildinfo.Version,
		Reason:       "lwt",
		TS:           time.Now().UTC(),
	})

	opts := mqtt.NewClientOptions()
	opts.AddBroker(fmt.Sprintf("ssl://%s:%d", cfg.MQTT.Host, cfg.MQTT.Port))
	opts.SetTLSConfig(tlsCfg)
	opts.SetClientID(cfg.DeviceID)
	opts.SetUsername(cfg.MQTT.Username)
	opts.SetPassword(cfg.MQTT.Password)

	// Retained will, so a dashboard subscribing at any moment sees real state.
	opts.SetBinaryWill(statusTopic, will, 1, true)

	// The supervisory loop below owns initial-connect backoff, so paho's
	// fixed-interval ConnectRetry is disabled to stop the two fighting.
	opts.SetConnectRetry(false)
	opts.SetAutoReconnect(true)
	// The 10-minute default is an unacceptable blind spot for an RMM agent.
	opts.SetMaxReconnectInterval(2 * time.Minute)
	opts.SetConnectTimeout(20 * time.Second)
	opts.SetKeepAlive(30 * time.Second)
	opts.SetPingTimeout(10 * time.Second)
	// Default is 0, which blocks forever on a black-holed connection.
	opts.SetWriteTimeout(30 * time.Second)

	// CleanSession=true is a safety decision, not a performance one: with
	// persistent sessions a device offline for six hours would reconnect and
	// immediately execute six hours of queued root commands whose operational
	// context is long gone. Durability belongs in the backend's database,
	// where an operator can still cancel.
	opts.SetCleanSession(true)
	opts.SetResumeSubs(false)
	opts.SetStore(mqtt.NewMemoryStore())
	opts.SetOrderMatters(false)

	opts.SetDefaultPublishHandler(func(_ mqtt.Client, m mqtt.Message) {
		log.Warn("message on unexpected topic", "topic", m.Topic())
	})
	opts.SetConnectionLostHandler(func(_ mqtt.Client, err error) {
		log.Error("broker connection lost", "err", err)
	})
	opts.SetReconnectingHandler(func(_ mqtt.Client, _ *mqtt.ClientOptions) {
		log.Info("reconnecting to broker")
	})

	// Fires on first connect AND every reconnect. With CleanSession the broker
	// has forgotten our subscriptions, so this is the only place they are set.
	opts.SetOnConnectHandler(func(client mqtt.Client) {
		cmdTopic := protocol.CommandTopic(cfg.DeviceID)
		if t := client.Subscribe(cmdTopic, 1, onCommand); t.Wait() && t.Error() != nil {
			// Do not announce "online" if we cannot receive commands.
			log.Error("subscribe failed", "topic", cmdTopic, "err", t.Error())
			return
		}
		for _, group := range c.currentGroups() {
			topic := protocol.BroadcastTopic(group)
			if t := client.Subscribe(topic, 1, onCommand); t.Wait() && t.Error() != nil {
				log.Error("group subscribe failed", "topic", topic, "err", t.Error())
			}
		}

		online, _ := json.Marshal(protocol.Status{
			V:            protocol.Version,
			State:        "online",
			DeviceID:     cfg.DeviceID,
			SessionID:    c.sessionID,
			BootID:       osinfo.BootID(),
			AgentVersion: buildinfo.Version,
			StartedAt:    c.startedAt.Format(time.RFC3339),
			TS:           time.Now().UTC(),
			OS:           osinfo.Cached(),
			Metrics:      snapshotMetrics(),
		})
		client.Publish(statusTopic, 1, true, online)
		log.Info("connected and subscribed", "device_id", cfg.DeviceID)
	})

	c.mqtt = mqtt.NewClient(opts)
	return c, nil
}

// Connect retries with exponential backoff and jitter. paho's own
// ConnectRetryInterval is a FIXED interval, which would make a fleet installed
// by one script retry in lockstep.
func (c *Client) Connect(ctx context.Context) error {
	backoff := 2 * time.Second
	const maxBackoff = 2 * time.Minute

	for {
		token := c.mqtt.Connect()
		done := make(chan struct{})
		go func() {
			token.Wait()
			close(done)
		}()

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-done:
		}

		if token.Error() == nil {
			return nil
		}

		c.log.Error("connect failed", "err", token.Error(), "retry_in", backoff)
		jitter := time.Duration(rand.Int63n(int64(backoff / 2)))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff/2 + jitter):
		}
		if backoff *= 2; backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

func (c *Client) PublishResult(r *protocol.Result) error {
	payload, err := json.Marshal(r)
	if err != nil {
		return err
	}
	// Chunks are cosmetic progress; QoS 0 avoids amplifying a chatty stream
	// over a flaky link. The authoritative result always goes at QoS 1.
	qos := byte(1)
	if r.Kind == protocol.KindChunk {
		qos = 0
	}
	token := c.mqtt.Publish(protocol.ResultTopic(c.cfg.DeviceID), qos, false, payload)
	token.Wait()
	return token.Error()
}

// Heartbeat publishes non-retained liveness. Retaining it would rewrite the
// broker's retained store for every device every interval for no benefit.
func (c *Client) Heartbeat() {
	sample := metrics.Collect()
	payload, _ := json.Marshal(protocol.Status{
		V: protocol.Version, State: "online", DeviceID: c.cfg.DeviceID,
		SessionID: c.sessionID, AgentVersion: buildinfo.Version,
		TS: time.Now().UTC(),
		Metrics: &protocol.Metrics{
			CPUPercent: sample.CPUPercent,
			MemTotalKB: sample.MemTotalKB, MemUsedKB: sample.MemUsedKB,
			MemPercent: sample.MemPercent,
			DiskTotalKB: sample.DiskTotalKB, DiskUsedKB: sample.DiskUsedKB,
			DiskPercent: sample.DiskPercent,
			Load1: sample.Load1, Load5: sample.Load5, Load15: sample.Load15,
			UptimeSec: sample.UptimeSec, Processes: sample.Processes,
		},
	})
	c.mqtt.Publish(protocol.StatusTopic(c.cfg.DeviceID), 0, false, payload)
}

// Disconnect publishes a retained "offline" with a shutdown reason first, so a
// planned stop is visually distinct from a crash.
func (c *Client) Disconnect() {
	payload, _ := json.Marshal(protocol.Status{
		V: protocol.Version, State: "offline", DeviceID: c.cfg.DeviceID,
		SessionID: c.sessionID, AgentVersion: buildinfo.Version,
		Reason: "shutdown", TS: time.Now().UTC(),
	})
	token := c.mqtt.Publish(protocol.StatusTopic(c.cfg.DeviceID), 1, true, payload)
	token.WaitTimeout(3 * time.Second)
	c.mqtt.Disconnect(250)
}

func (c *Client) IsConnected() bool { return c.mqtt.IsConnected() }

func (c *Client) currentGroups() []string {
	c.groupsMu.Lock()
	defer c.groupsMu.Unlock()
	return append([]string(nil), c.groups...)
}

// UpdateGroups replaces the broadcast subscriptions and persists the change,
// so a membership edit in the dashboard takes effect without re-enrolling and
// survives a restart.
func (c *Client) UpdateGroups(groups []string, configPath string) error {
	c.groupsMu.Lock()
	previous := append([]string(nil), c.groups...)
	c.groups = append([]string(nil), groups...)
	c.groupsMu.Unlock()

	inNew := make(map[string]bool, len(groups))
	for _, g := range groups {
		inNew[g] = true
	}
	inOld := make(map[string]bool, len(previous))
	for _, g := range previous {
		inOld[g] = true
	}

	for _, g := range previous {
		if inNew[g] {
			continue
		}
		topic := protocol.BroadcastTopic(g)
		if t := c.mqtt.Unsubscribe(topic); t.Wait() && t.Error() != nil {
			c.log.Warn("unsubscribe failed", "topic", topic, "err", t.Error())
		}
	}

	for _, g := range groups {
		if inOld[g] {
			continue
		}
		topic := protocol.BroadcastTopic(g)
		if t := c.mqtt.Subscribe(topic, 1, c.onCommand); t.Wait() && t.Error() != nil {
			return fmt.Errorf("subscribe %s: %w", topic, t.Error())
		}
	}

	c.cfg.Groups = append([]string(nil), groups...)
	if configPath != "" {
		if err := config.Save(configPath, c.cfg); err != nil {
			return fmt.Errorf("persist groups: %w", err)
		}
	}

	c.log.Info("broadcast groups updated", "groups", groups)
	return nil
}

func snapshotMetrics() *protocol.Metrics {
	s := metrics.Collect()
	return &protocol.Metrics{
		CPUPercent: s.CPUPercent,
		MemTotalKB: s.MemTotalKB, MemUsedKB: s.MemUsedKB, MemPercent: s.MemPercent,
		DiskTotalKB: s.DiskTotalKB, DiskUsedKB: s.DiskUsedKB, DiskPercent: s.DiskPercent,
		Load1: s.Load1, Load5: s.Load5, Load15: s.Load15,
		UptimeSec: s.UptimeSec, Processes: s.Processes,
	}
}

func randomHex(n int) string {
	const hexDigits = "0123456789abcdef"
	b := make([]byte, n*2)
	for i := range b {
		b[i] = hexDigits[rand.Intn(16)]
	}
	return string(b)
}
