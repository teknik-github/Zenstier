// Package dispatch turns inbound MQTT messages into bounded concurrent work.
package dispatch

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"github.com/zenstier/agent/internal/buildinfo"
	"github.com/zenstier/agent/internal/config"
	"github.com/zenstier/agent/internal/dedupe"
	"github.com/zenstier/agent/internal/executor"
	"github.com/zenstier/agent/internal/protocol"
)

// Publisher sends a result message back to the broker.
type Publisher interface {
	PublishResult(r *protocol.Result) error
}

type job struct {
	cmd      protocol.Command
	received time.Time
}

// GroupUpdater applies a new broadcast-group membership list.
type GroupUpdater func(groups []string) error

type Dispatcher struct {
	queue    chan job
	cfg      config.ExecConfig
	deviceID string
	exec     *executor.Executor
	pub      Publisher
	seen     *dedupe.Cache
	log      *slog.Logger
	wg       sync.WaitGroup
	running  sync.Map // command id -> context.CancelFunc

	// Set after construction: the MQTT client needs this dispatcher's handler,
	// so the dependency has to be closed afterwards.
	onUpdateGroups GroupUpdater
}

// SetGroupUpdater wires the resubscribe hook used by update_groups commands.
func (d *Dispatcher) SetGroupUpdater(fn GroupUpdater) { d.onUpdateGroups = fn }

func New(
	deviceID string,
	cfg config.ExecConfig,
	pub Publisher,
	log *slog.Logger,
) *Dispatcher {
	return &Dispatcher{
		queue:    make(chan job, cfg.QueueDepth),
		cfg:      cfg,
		deviceID: deviceID,
		exec:     executor.New(cfg),
		pub:      pub,
		seen:     dedupe.New(1024, time.Hour),
		log:      log,
	}
}

// Start launches a fixed worker pool. A bounded pool converts a
// resource-exhaustion failure into a legible one: 5,000 queued commands would
// otherwise spawn 5,000 shells and OOM the host.
func (d *Dispatcher) Start(ctx context.Context) {
	for i := 0; i < d.cfg.MaxConcurrent; i++ {
		d.wg.Add(1)
		go func(worker int) {
			defer d.wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case j, ok := <-d.queue:
					if !ok {
						return
					}
					d.run(ctx, j)
				}
			}
		}(i)
	}
}

func (d *Dispatcher) Wait() { d.wg.Wait() }

// HandleMessage is the paho callback. It MUST NOT BLOCK: blocking here lets
// inbound pressure translate directly into goroutine count.
func (d *Dispatcher) HandleMessage(_ mqtt.Client, msg mqtt.Message) {
	var cmd protocol.Command
	if err := json.Unmarshal(msg.Payload(), &cmd); err != nil {
		d.log.Error("malformed command", "topic", msg.Topic(), "err", err)
		return // no id, so nowhere to send a result
	}
	if cmd.Type == "" {
		cmd.Type = protocol.TypeExec
	}

	// A broadcast carries only the batch id. Derive our own command id so the
	// result maps to the row the server already inserted for this device.
	if cmd.ID == "" && cmd.BatchID != "" {
		cmd.ID = protocol.DeriveCommandID(cmd.BatchID, d.deviceID)
	}

	if err := cmd.Validate(); err != nil {
		d.reject(cmd.ID, protocol.ErrInvalidCommand, err.Error())
		return
	}

	// Defence in depth: never run a command whose operational context has
	// expired, even if the broker delivers it late.
	if !cmd.ExpiresAt.IsZero() && time.Now().After(cmd.ExpiresAt) {
		d.reject(cmd.ID, protocol.ErrExpired, "command expired before delivery")
		return
	}

	// Cancel bypasses the queue entirely — one that queued behind the job it
	// cancels would be useless.
	if cmd.Type == protocol.TypeCancel {
		d.cancel(cmd.TargetID)
		return
	}

	// Likewise a membership change: it is control-plane, and waiting behind a
	// long-running exec would leave the device deaf to its new group.
	if cmd.Type == protocol.TypeUpdateGroups {
		if d.onUpdateGroups == nil {
			d.reject(cmd.ID, protocol.ErrUnsupportedType, "group updates not supported")
			return
		}
		if err := d.onUpdateGroups(cmd.Groups); err != nil {
			d.log.Error("group update failed", "err", err)
			d.reject(cmd.ID, protocol.ErrInternal, err.Error())
			return
		}
		d.finish(&protocol.Result{
			V: protocol.Version, ID: cmd.ID, DeviceID: d.deviceID,
			Kind: protocol.KindResult, Status: protocol.StatusCompleted,
			AgentVersion: buildinfo.Version,
		})
		return
	}

	if first := d.seen.Add(cmd.ID); !first {
		// A duplicate usually means the original result was lost, so replaying
		// it is the actively helpful response.
		if result, running, ok := d.seen.CachedResult(cmd.ID); ok {
			if running {
				d.publish(&protocol.Result{
					V: protocol.Version, ID: cmd.ID, DeviceID: d.deviceID,
					Kind: protocol.KindAccepted, Status: protocol.StatusRunning,
				})
			} else if result != nil {
				var cached protocol.Result
				if json.Unmarshal(result, &cached) == nil {
					d.publish(&cached)
				}
			}
		}
		d.log.Info("duplicate command suppressed", "command_id", cmd.ID)
		return
	}

	select {
	case d.queue <- job{cmd: cmd, received: time.Now()}:
		d.publish(&protocol.Result{
			V: protocol.Version, ID: cmd.ID, DeviceID: d.deviceID,
			Kind: protocol.KindAccepted, Status: protocol.StatusQueued,
		})
	default:
		// Overload: reject loudly. A silent drop produces unfalsifiable
		// "the command just didn't run?" reports.
		d.seen.Remove(cmd.ID)
		d.reject(cmd.ID, protocol.ErrAgentBusy,
			fmt.Sprintf("queue full (%d queued, %d workers)",
				cap(d.queue), d.cfg.MaxConcurrent))
	}
}

func (d *Dispatcher) run(parent context.Context, j job) {
	ctx, cancel := context.WithCancel(parent)
	d.running.Store(j.cmd.ID, cancel)
	defer func() {
		d.running.Delete(j.cmd.ID)
		cancel()
	}()

	switch j.cmd.Type {
	case protocol.TypePing:
		d.finish(&protocol.Result{
			V: protocol.Version, ID: j.cmd.ID, DeviceID: d.deviceID,
			Kind: protocol.KindResult, Status: protocol.StatusCompleted,
			Stdout: "pong", AgentVersion: buildinfo.Version,
		})
		return
	case protocol.TypeCollectFacts:
		d.finish(&protocol.Result{
			V: protocol.Version, ID: j.cmd.ID, DeviceID: d.deviceID,
			Kind: protocol.KindResult, Status: protocol.StatusCompleted,
			AgentVersion: buildinfo.Version,
		})
		return
	}

	d.publish(&protocol.Result{
		V: protocol.Version, ID: j.cmd.ID, DeviceID: d.deviceID,
		Kind: protocol.KindAccepted, Status: protocol.StatusRunning,
	})

	// Sequence numbers must be monotonic across BOTH streams: the backend's
	// uniqueness key is (command_id, seq).
	var seq int64
	var sink executor.ChunkSink
	if j.cmd.Stream {
		sink = func(stream, data string) {
			n := atomic.AddInt64(&seq, 1) - 1
			d.publish(&protocol.Result{
				V: protocol.Version, ID: j.cmd.ID, DeviceID: d.deviceID,
				Kind: protocol.KindChunk, Seq: int(n), Stream: stream,
				Data: data,
			})
		}
	}

	res, err := d.exec.Run(ctx, j.cmd, sink)
	if err != nil {
		d.finish(&protocol.Result{
			V: protocol.Version, ID: j.cmd.ID, DeviceID: d.deviceID,
			Kind: protocol.KindResult, Status: protocol.StatusRejected,
			ErrorCode: protocol.ErrSpawnFailed, Error: err.Error(),
			AgentVersion: buildinfo.Version,
		})
		return
	}

	status := protocol.StatusCompleted
	errCode := ""
	switch {
	case res.TimedOut:
		status, errCode = protocol.StatusTimeout, protocol.ErrTimeout
	case res.Canceled:
		status = protocol.StatusCanceled
	case res.ExitCode != 0:
		status = protocol.StatusFailed
	}

	startedAt := res.StartedAt
	finishedAt := time.Now()
	exitCode := res.ExitCode
	duration := res.DurationMS

	d.finish(&protocol.Result{
		V: protocol.Version, ID: j.cmd.ID, DeviceID: d.deviceID,
		Kind: protocol.KindResult, Status: status,
		ExitCode: &exitCode,
		Stdout:   string(res.Stdout), Stderr: string(res.Stderr),
		Truncated: res.Truncated, DroppedBytes: res.Dropped,
		StartedAt: &startedAt, FinishedAt: &finishedAt, DurationMS: &duration,
		AgentVersion: buildinfo.Version, ErrorCode: errCode,
	})
}

func (d *Dispatcher) cancel(targetID string) {
	if v, ok := d.running.Load(targetID); ok {
		if cancel, ok := v.(context.CancelFunc); ok {
			cancel()
			d.log.Info("command canceled", "command_id", targetID)
		}
	}
}

func (d *Dispatcher) reject(id, code, message string) {
	if id == "" {
		return
	}
	d.publish(&protocol.Result{
		V: protocol.Version, ID: id, DeviceID: d.deviceID,
		Kind: protocol.KindResult, Status: protocol.StatusRejected,
		ErrorCode: code, Error: message, AgentVersion: buildinfo.Version,
	})
}

func (d *Dispatcher) finish(r *protocol.Result) {
	if encoded, err := json.Marshal(r); err == nil {
		d.seen.Complete(r.ID, encoded)
	}
	d.publish(r)
}

func (d *Dispatcher) publish(r *protocol.Result) {
	if err := d.pub.PublishResult(r); err != nil {
		d.log.Error("publish result failed", "command_id", r.ID, "err", err)
	}
}
