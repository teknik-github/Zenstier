// Package executor runs shell commands with timeouts, bounded output and
// process-group cleanup.
package executor

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/zenstier/agent/internal/config"
	"github.com/zenstier/agent/internal/protocol"
)

const (
	// Flush cadence for live output. 500ms keeps a busy command from producing
	// an MQTT message per line while still feeling immediate.
	streamFlushInterval = 500 * time.Millisecond
	// Size trigger, well under Mosquitto's 256 KiB message_size_limit.
	streamChunkBytes = 32 * 1024
)

type Result struct {
	ExitCode   int
	Stdout     []byte
	Stderr     []byte
	Truncated  bool
	Dropped    int
	TimedOut   bool
	Canceled   bool
	StartedAt  time.Time
	DurationMS int64
}

type Executor struct {
	cfg config.ExecConfig
}

func New(cfg config.ExecConfig) *Executor { return &Executor{cfg: cfg} }

// Run executes one command. The returned error is non-nil only for failures to
// spawn; a non-zero exit is reported through Result.
// Run executes one command. When sink is non-nil, output is also emitted
// incrementally while the process is still running.
func (e *Executor) Run(
	ctx context.Context,
	cmd protocol.Command,
	sink ChunkSink,
) (*Result, error) {
	timeout := e.cfg.DefaultTimeout.D
	if cmd.TimeoutSec > 0 {
		timeout = time.Duration(cmd.TimeoutSec) * time.Second
	}
	// Clamp whatever the server asked for.
	if timeout > e.cfg.MaxTimeout.D {
		timeout = e.cfg.MaxTimeout.D
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	shell := firstNonEmpty(cmd.Shell, e.cfg.Shell, "/bin/sh")
	proc := exec.CommandContext(ctx, shell, "-c", cmd.Command)

	workDir := firstNonEmpty(cmd.WorkDir, e.cfg.WorkDir, "/")
	if _, err := os.Stat(workDir); err != nil {
		return nil, errors.New("work_dir does not exist: " + workDir)
	}
	proc.Dir = workDir

	// Its own process group, so the whole tree can be signalled.
	proc.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	if cmd.RunAs != "" {
		cred, err := resolveUser(cmd.RunAs)
		if err != nil {
			return nil, err
		}
		proc.SysProcAttr.Credential = cred
	}

	proc.Env = buildEnv(cmd)
	// Closed stdin: a command that blocks on a prompt must fail fast rather
	// than hold a worker slot until the timeout.
	proc.Stdin = nil

	maxOut := e.cfg.MaxOutputBytes
	if cmd.MaxOutput > 0 && cmd.MaxOutput < maxOut {
		maxOut = cmd.MaxOutput
	}
	outW, errW := newCapWriter(maxOut), newCapWriter(maxOut)

	// The capped writers remain the authoritative capture; the emitters are a
	// parallel tee so the dashboard can follow a long-running command live.
	var (
		outEmit  = newChunkEmitter("stdout", streamChunkBytes, sink)
		errEmit  = newChunkEmitter("stderr", streamChunkBytes, sink)
		stopFlush = make(chan struct{})
	)
	if sink != nil {
		proc.Stdout = io.MultiWriter(outW, outEmit)
		proc.Stderr = io.MultiWriter(errW, errEmit)
		startFlusher(streamFlushInterval, stopFlush, outEmit, errEmit)
	} else {
		proc.Stdout, proc.Stderr = outW, errW
	}

	// On timeout/cancel: SIGTERM the whole group...
	proc.Cancel = func() error {
		if proc.Process == nil {
			return nil
		}
		return syscall.Kill(-proc.Process.Pid, syscall.SIGTERM)
	}
	// ...then force. WaitDelay also closes the pipes, so Wait returns even if
	// an orphaned grandchild still holds the write end — otherwise Wait can
	// block forever despite the child having exited.
	proc.WaitDelay = 5 * time.Second

	started := time.Now()
	if err := proc.Start(); err != nil {
		return nil, err
	}
	pgid := proc.Process.Pid

	waitErr := proc.Wait()

	// Stop the ticker first, then drain whatever is left so no tail is lost.
	if sink != nil {
		close(stopFlush)
		outEmit.Close()
		errEmit.Close()
	}

	// WaitDelay's kill only reaches the direct child; reap the rest.
	_ = syscall.Kill(-pgid, syscall.SIGKILL)

	res := &Result{
		Stdout:     outW.Bytes(),
		Stderr:     errW.Bytes(),
		Truncated:  outW.Truncated() || errW.Truncated(),
		Dropped:    outW.Dropped() + errW.Dropped(),
		StartedAt:  started,
		DurationMS: time.Since(started).Milliseconds(),
		ExitCode:   exitCodeOf(waitErr),
	}

	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		res.TimedOut = true
		res.ExitCode = 124 // matches GNU timeout(1)
	case errors.Is(ctx.Err(), context.Canceled):
		res.Canceled = true
		res.ExitCode = 125
	}
	return res, nil
}

func exitCodeOf(err error) int {
	if err == nil {
		return 0
	}
	// Output may be incomplete, but the process did exit.
	if errors.Is(err, exec.ErrWaitDelay) {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if status, ok := ee.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return 128 + int(status.Signal())
		}
		return ee.ExitCode()
	}
	return -1
}

// buildEnv constructs a deterministic environment rather than inheriting
// systemd's, which is not a sane base for admin commands.
func buildEnv(cmd protocol.Command) []string {
	home, shell := "/root", "/bin/sh"
	username := "root"
	if cmd.RunAs != "" {
		if u, err := user.Lookup(cmd.RunAs); err == nil {
			home, username = u.HomeDir, u.Username
		}
	}

	env := map[string]string{
		"PATH":     "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME":     home,
		"USER":     username,
		"LOGNAME":  username,
		"SHELL":    shell,
		"LANG":     "C.UTF-8",
		"TERM":     "dumb",
		// Stops apt hanging on an interactive config prompt.
		"DEBIAN_FRONTEND":    "noninteractive",
		"ZENSTIER_COMMAND_ID": cmd.ID,
	}

	// Variables that can subvert the shell are never accepted from the wire.
	denied := map[string]bool{
		"LD_PRELOAD": true, "LD_LIBRARY_PATH": true,
		"IFS": true, "BASH_ENV": true, "ENV": true,
	}
	for k, v := range cmd.Env {
		if denied[strings.ToUpper(k)] {
			continue
		}
		env[k] = v
	}

	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

func resolveUser(name string) (*syscall.Credential, error) {
	u, err := user.Lookup(name)
	if err != nil {
		return nil, err
	}
	uid, err := strconv.Atoi(u.Uid)
	if err != nil {
		return nil, err
	}
	gid, err := strconv.Atoi(u.Gid)
	if err != nil {
		return nil, err
	}

	// Without supplementary groups a dropped-privilege command silently loses
	// docker/adm access and fails confusingly.
	var groups []uint32
	if ids, err := u.GroupIds(); err == nil {
		for _, g := range ids {
			if n, err := strconv.Atoi(g); err == nil {
				groups = append(groups, uint32(n))
			}
		}
	}
	return &syscall.Credential{
		Uid: uint32(uid), Gid: uint32(gid), Groups: groups,
	}, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
