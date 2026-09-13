// Package protocol defines the Zenstier MQTT wire format.
//
// This is the contract with the Next.js backend (mirrored in
// src/lib/protocol.ts). Any change here must be mirrored there and the
// version bumped.
package protocol

import (
	"fmt"
	"time"
)

const Version = 1

// Topics.
func CommandTopic(deviceID string) string   { return fmt.Sprintf("zenstier/%s/command", deviceID) }
func ResultTopic(deviceID string) string    { return fmt.Sprintf("zenstier/%s/result", deviceID) }
func StatusTopic(deviceID string) string     { return fmt.Sprintf("zenstier/%s/status", deviceID) }
func BroadcastTopic(groupID string) string  { return fmt.Sprintf("zenstier/broadcast/%s/command", groupID) }

// Command types.
const (
	TypeExec         = "exec"
	TypeCancel       = "cancel"
	TypePing         = "ping"
	TypeCollectFacts = "collect_facts"
	TypeUpdateGroups = "update_groups"
)

// Result kinds.
const (
	KindAccepted = "accepted"
	KindChunk    = "chunk"
	KindResult   = "result"
)

// Result statuses.
const (
	StatusQueued    = "queued"
	StatusRunning   = "running"
	StatusCompleted = "completed"
	StatusFailed    = "failed"
	StatusTimeout   = "timeout"
	StatusCanceled  = "canceled"
	StatusRejected  = "rejected"
)

// Error codes.
const (
	ErrAgentBusy       = "agent_busy"
	ErrInvalidCommand  = "invalid_command"
	ErrExpired         = "expired"
	ErrUnsupportedType = "unsupported_type"
	ErrSpawnFailed     = "spawn_failed"
	ErrRunAsFailed     = "run_as_failed"
	ErrTimeout         = "timeout"
	ErrInternal        = "internal"
)

// Command is published by the backend to a device's command topic.
type Command struct {
	V          int               `json:"v"`
	ID         string            `json:"id"`
	BatchID    string            `json:"batch_id,omitempty"`
	Type       string            `json:"type"`
	IssuedAt   time.Time         `json:"issued_at"`
	ExpiresAt  time.Time         `json:"expires_at"`
	IssuedBy   string            `json:"issued_by,omitempty"`
	Command    string            `json:"command"`
	Shell      string            `json:"shell,omitempty"`
	WorkDir    string            `json:"work_dir,omitempty"`
	Env        map[string]string `json:"env,omitempty"`
	RunAs      string            `json:"run_as,omitempty"`
	TimeoutSec int               `json:"timeout_sec,omitempty"`
	Stream     bool              `json:"stream,omitempty"`
	MaxOutput  int               `json:"max_output_bytes,omitempty"`
	TargetID   string            `json:"target_id,omitempty"` // for type=cancel
	Groups     []string          `json:"groups,omitempty"`    // for type=update_groups
}

// Validate applies the checks that must pass before a command is queued.
func (c *Command) Validate() error {
	if c.V != Version {
		return fmt.Errorf("unsupported protocol version %d", c.V)
	}
	if c.ID == "" {
		return fmt.Errorf("missing command id")
	}
	switch c.Type {
	case "", TypeExec:
		if c.Command == "" {
			return fmt.Errorf("empty command")
		}
	case TypeCancel:
		if c.TargetID == "" {
			return fmt.Errorf("cancel requires target_id")
		}
	case TypeUpdateGroups, TypePing, TypeCollectFacts:
	default:
		return fmt.Errorf("unsupported type %q", c.Type)
	}
	return nil
}

// Result is published by the device to its result topic.
type Result struct {
	V            int    `json:"v"`
	ID           string `json:"id"`
	DeviceID     string `json:"device_id"`
	Kind         string `json:"kind"`
	Status       string `json:"status,omitempty"`
	ExitCode     *int   `json:"exit_code,omitempty"`
	Stdout       string `json:"stdout,omitempty"`
	Stderr       string `json:"stderr,omitempty"`
	Truncated    bool   `json:"truncated,omitempty"`
	DroppedBytes int    `json:"dropped_bytes,omitempty"`

	StartedAt  *time.Time `json:"started_at,omitempty"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	DurationMS *int64     `json:"duration_ms,omitempty"`

	AgentVersion string `json:"agent_version,omitempty"`
	ErrorCode    string `json:"error_code,omitempty"`
	Error        string `json:"error,omitempty"`

	// chunk-only
	Seq    int    `json:"seq,omitempty"`
	Stream string `json:"stream,omitempty"`
	Data   string `json:"data,omitempty"`
	EOF    bool   `json:"eof,omitempty"`
}

// OSInfo describes the host, reported at enrollment and on every connect.
type OSInfo struct {
	Distro   string `json:"distro,omitempty"`
	VersionID string `json:"version,omitempty"`
	Kernel   string `json:"kernel,omitempty"`
	Arch     string `json:"arch,omitempty"`
	Pretty   string `json:"pretty,omitempty"`
	Hostname string `json:"hostname,omitempty"`
}

// Metrics is the resource snapshot attached to heartbeats.
type Metrics struct {
	CPUPercent  float64 `json:"cpu_percent"`
	MemTotalKB  uint64  `json:"mem_total_kb"`
	MemUsedKB   uint64  `json:"mem_used_kb"`
	MemPercent  float64 `json:"mem_percent"`
	DiskTotalKB uint64  `json:"disk_total_kb"`
	DiskUsedKB  uint64  `json:"disk_used_kb"`
	DiskPercent float64 `json:"disk_percent"`
	Load1       float64 `json:"load1"`
	Load5       float64 `json:"load5"`
	Load15      float64 `json:"load15"`
	UptimeSec   uint64  `json:"uptime_sec"`
	Processes   int     `json:"processes"`
}

// Status is published retained on the device's status topic.
type Status struct {
	V            int       `json:"v"`
	State        string    `json:"state"` // online | offline
	DeviceID     string    `json:"device_id"`
	AgentVersion string    `json:"agent_version,omitempty"`
	SessionID    string    `json:"session_id,omitempty"`
	BootID       string    `json:"boot_id,omitempty"`
	Reason       string    `json:"reason,omitempty"`
	StartedAt    string    `json:"started_at,omitempty"`
	TS           time.Time `json:"ts"`
	OS           *OSInfo   `json:"os,omitempty"`
	Metrics      *Metrics  `json:"metrics,omitempty"`
}
