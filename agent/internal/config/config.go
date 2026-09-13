// Package config loads and persists the agent's on-disk configuration.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"gopkg.in/yaml.v3"
)

const DefaultPath = "/etc/zenstier/config.yaml"

// Duration lets the YAML file carry human-readable values like "5m".
type Duration struct{ D time.Duration }

func (d *Duration) UnmarshalYAML(node *yaml.Node) error {
	var s string
	if err := node.Decode(&s); err != nil {
		return err
	}
	parsed, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("invalid duration %q: %w", s, err)
	}
	d.D = parsed
	return nil
}

func (d Duration) MarshalYAML() (any, error) { return d.D.String(), nil }

type MQTTConfig struct {
	Host     string `yaml:"host"`
	Port     int    `yaml:"port"`
	Username string `yaml:"username"`
	Password string `yaml:"password"`
	CAFile   string `yaml:"ca_file,omitempty"`
	// InsecureSkipVerify is deliberately not a config knob. There is no
	// scenario in which a root agent should skip certificate verification.
}

type ExecConfig struct {
	Shell          string   `yaml:"shell"`
	DefaultTimeout Duration `yaml:"default_timeout"`
	MaxTimeout     Duration `yaml:"max_timeout"`
	MaxConcurrent  int      `yaml:"max_concurrent"`
	QueueDepth     int      `yaml:"queue_depth"`
	MaxOutputBytes int      `yaml:"max_output_bytes"`
	WorkDir        string   `yaml:"work_dir"`
}

type AgentConfig struct {
	HeartbeatInterval Duration `yaml:"heartbeat_interval"`
	LogLevel          string   `yaml:"log_level"`
}

type Config struct {
	Version   int         `yaml:"version"`
	DeviceID  string      `yaml:"device_id"`
	ServerURL string      `yaml:"server_url"`
	MQTT      MQTTConfig  `yaml:"mqtt"`
	Exec      ExecConfig  `yaml:"exec"`
	Agent     AgentConfig `yaml:"agent"`
	Groups    []string    `yaml:"groups,omitempty"`
}

func Defaults() Config {
	return Config{
		Version: 1,
		Exec: ExecConfig{
			Shell:          "/bin/sh",
			DefaultTimeout: Duration{5 * time.Minute},
			MaxTimeout:     Duration{time.Hour},
			MaxConcurrent:  4,
			QueueDepth:     32,
			MaxOutputBytes: 1 << 20,
			WorkDir:        "/",
		},
		Agent: AgentConfig{
			HeartbeatInterval: Duration{30 * time.Second},
			LogLevel:          "info",
		},
	}
}

// Load reads the config and refuses to continue if the file holding the broker
// password is readable by anyone but its owner.
func Load(path string) (*Config, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf(
			"%s is group/world accessible (%04o); run: chmod 0600 %s",
			path, info.Mode().Perm(), path)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	cfg := Defaults()
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	// Re-apply defaults for anything the file left empty.
	d := Defaults()
	if cfg.Exec.Shell == "" {
		cfg.Exec.Shell = d.Exec.Shell
	}
	if cfg.Exec.DefaultTimeout.D == 0 {
		cfg.Exec.DefaultTimeout = d.Exec.DefaultTimeout
	}
	if cfg.Exec.MaxTimeout.D == 0 {
		cfg.Exec.MaxTimeout = d.Exec.MaxTimeout
	}
	if cfg.Exec.MaxConcurrent <= 0 {
		cfg.Exec.MaxConcurrent = d.Exec.MaxConcurrent
	}
	if cfg.Exec.QueueDepth <= 0 {
		cfg.Exec.QueueDepth = d.Exec.QueueDepth
	}
	if cfg.Exec.MaxOutputBytes <= 0 {
		cfg.Exec.MaxOutputBytes = d.Exec.MaxOutputBytes
	}
	if cfg.Exec.WorkDir == "" {
		cfg.Exec.WorkDir = d.Exec.WorkDir
	}
	if cfg.Agent.HeartbeatInterval.D == 0 {
		cfg.Agent.HeartbeatInterval = d.Agent.HeartbeatInterval
	}

	if cfg.DeviceID == "" {
		return nil, fmt.Errorf("config is missing device_id; run `zenstier enroll`")
	}
	if cfg.MQTT.Host == "" || cfg.MQTT.Port == 0 {
		return nil, fmt.Errorf("config is missing mqtt.host/mqtt.port")
	}
	return &cfg, nil
}

// Save writes the config atomically with 0600 permissions.
func Save(path string, cfg *Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}

	out, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}

	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		// A leftover temp file from a crashed run must not block enrollment.
		if os.IsExist(err) {
			_ = os.Remove(tmp)
			f, err = os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		}
		if err != nil {
			return fmt.Errorf("open temp config: %w", err)
		}
	}

	if _, err := f.Write(out); err != nil {
		f.Close()
		os.Remove(tmp)
		return fmt.Errorf("write config: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return fmt.Errorf("sync config: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}
