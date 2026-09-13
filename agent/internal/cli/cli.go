// Package cli implements the zenstier subcommands.
package cli

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/zenstier/agent/internal/buildinfo"
	"github.com/zenstier/agent/internal/config"
	"github.com/zenstier/agent/internal/dispatch"
	"github.com/zenstier/agent/internal/enroll"
	"github.com/zenstier/agent/internal/logging"
	"github.com/zenstier/agent/internal/mqttc"
	"github.com/zenstier/agent/internal/osinfo"
	"github.com/zenstier/agent/internal/protocol"
)

// publisherFunc adapts a function to dispatch.Publisher. It exists to break the
// construction cycle: the dispatcher needs a publisher, and the MQTT client
// needs the dispatcher's message handler.
type publisherFunc func(*protocol.Result) error

func (f publisherFunc) PublishResult(r *protocol.Result) error { return f(r) }

// Enroll registers this host and writes the agent config.
func Enroll(args []string) error {
	fs := flag.NewFlagSet("enroll", flag.ExitOnError)
	token := fs.String("token", "", "enrollment token from the dashboard")
	server := fs.String("server", "", "dashboard base URL, e.g. https://zenstier.example.com")
	cfgPath := fs.String("config", config.DefaultPath, "config file path")
	force := fs.Bool("force", false, "overwrite an existing configuration")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if *token == "" || *server == "" {
		fs.Usage()
		return fmt.Errorf("--token and --server are required")
	}
	if os.Geteuid() != 0 {
		return fmt.Errorf("enroll must run as root (writes %s)", *cfgPath)
	}

	// Refusing a silent re-enroll stops an install-script re-run from rotating
	// credentials on a healthy device.
	if _, err := os.Stat(*cfgPath); err == nil && !*force {
		return fmt.Errorf("%s already exists; pass --force to re-enroll", *cfgPath)
	}

	fmt.Printf("Enrolling %s with %s...\n", osinfo.Cached().Hostname, *server)
	resp, err := enroll.Enroll(*server, *token)
	if err != nil {
		return err
	}

	cfg := config.Defaults()
	cfg.DeviceID = resp.DeviceID
	cfg.ServerURL = *server
	cfg.Groups = resp.Groups
	cfg.MQTT = config.MQTTConfig{
		Host:     resp.MQTT.Host,
		Port:     resp.MQTT.Port,
		Username: resp.MQTT.Username,
		Password: resp.MQTT.Password,
	}

	// A private CA is delivered inside the authenticated enrollment response,
	// never fetched over an unauthenticated channel.
	if resp.CAPem != "" {
		caPath := filepath.Join(filepath.Dir(*cfgPath), "ca.crt")
		if err := os.MkdirAll(filepath.Dir(caPath), 0o700); err != nil {
			return fmt.Errorf("create config dir: %w", err)
		}
		if err := os.WriteFile(caPath, []byte(resp.CAPem), 0o644); err != nil {
			return fmt.Errorf("write CA: %w", err)
		}
		cfg.MQTT.CAFile = caPath
	}

	if err := config.Save(*cfgPath, &cfg); err != nil {
		return err
	}

	fmt.Printf("✓ Enrolled as %s\n", resp.DeviceID)
	fmt.Printf("  config: %s (0600)\n", *cfgPath)
	fmt.Printf("  broker: %s:%d\n\n", resp.MQTT.Host, resp.MQTT.Port)
	fmt.Println("Next: systemctl enable --now zenstier")
	return nil
}

// Run is the daemon entry point invoked by systemd.
func Run(args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	cfgPath := fs.String("config", config.DefaultPath, "config file path")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}

	log := logging.New(cfg.Agent.LogLevel)
	log.Info("zenstier agent starting",
		"version", buildinfo.Version,
		"device_id", cfg.DeviceID,
		"broker", fmt.Sprintf("%s:%d", cfg.MQTT.Host, cfg.MQTT.Port),
	)

	ctx, stop := signal.NotifyContext(context.Background(),
		syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// The dispatcher needs the client to publish; the client needs the
	// dispatcher's handler. Break the cycle with an indirection.
	var client *mqttc.Client
	pub := publisherFunc(func(r *protocol.Result) error {
		return client.PublishResult(r)
	})

	d := dispatch.New(cfg.DeviceID, cfg.Exec, pub, log)

	client, err = mqttc.New(cfg, d.HandleMessage, log)
	if err != nil {
		return err
	}

	// Closes the construction cycle: the client needed the dispatcher's
	// handler, and the dispatcher needs the client to resubscribe.
	d.SetGroupUpdater(func(groups []string) error {
		return client.UpdateGroups(groups, *cfgPath)
	})

	d.Start(ctx)

	if err := client.Connect(ctx); err != nil {
		return err
	}

	heartbeat := time.NewTicker(cfg.Agent.HeartbeatInterval.D)
	defer heartbeat.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Info("shutting down")
			// Give running commands a bounded window to finish; systemd's
			// TimeoutStopSec must exceed this.
			done := make(chan struct{})
			go func() { d.Wait(); close(done) }()
			select {
			case <-done:
			case <-time.After(10 * time.Second):
				log.Warn("timed out waiting for running commands")
			}
			client.Disconnect()
			return nil
		case <-heartbeat.C:
			if client.IsConnected() {
				client.Heartbeat()
			}
		}
	}
}

// Status prints local agent state for support purposes.
func Status(args []string) error {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	cfgPath := fs.String("config", config.DefaultPath, "config file path")
	if err := fs.Parse(args); err != nil {
		return err
	}

	facts := osinfo.Cached()
	fmt.Printf("zenstier %s (%s)\n", buildinfo.Version, buildinfo.Commit)
	fmt.Printf("host:    %s\n", facts.Hostname)
	fmt.Printf("os:      %s %s (%s)\n", facts.Distro, facts.VersionID, facts.Arch)
	fmt.Printf("kernel:  %s\n", facts.Kernel)

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		fmt.Printf("config:  NOT ENROLLED (%v)\n", err)
		return nil
	}
	fmt.Printf("config:  %s\n", *cfgPath)
	fmt.Printf("device:  %s\n", cfg.DeviceID)
	fmt.Printf("broker:  %s:%d\n", cfg.MQTT.Host, cfg.MQTT.Port)
	fmt.Printf("server:  %s\n", cfg.ServerURL)
	return nil
}

// Uninstall removes local state. It deliberately does not stop on a failed
// deregistration: a half-uninstalled root agent is the worse outcome.
func Uninstall(args []string) error {
	fs := flag.NewFlagSet("uninstall", flag.ExitOnError)
	cfgPath := fs.String("config", config.DefaultPath, "config file path")
	yes := fs.Bool("yes", false, "do not prompt")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if os.Geteuid() != 0 {
		return fmt.Errorf("uninstall must run as root")
	}
	if !*yes {
		fmt.Print("Remove Zenstier agent configuration? [y/N] ")
		var answer string
		fmt.Scanln(&answer)
		if answer != "y" && answer != "Y" {
			return fmt.Errorf("aborted")
		}
	}

	dir := filepath.Dir(*cfgPath)
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("remove %s: %w", dir, err)
	}
	fmt.Printf("✓ Removed %s\n", dir)
	fmt.Println("Now run: systemctl disable --now zenstier && rm /etc/systemd/system/zenstier.service")
	return nil
}
