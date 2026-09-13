package executor

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zenstier/agent/internal/config"
	"github.com/zenstier/agent/internal/protocol"
)

func testExecutor() *Executor {
	return New(config.ExecConfig{
		Shell:          "/bin/sh",
		DefaultTimeout: config.Duration{D: 30 * time.Second},
		MaxTimeout:     config.Duration{D: time.Minute},
		MaxOutputBytes: 1 << 20,
		WorkDir:        "/",
	})
}

// Output must arrive WHILE the command runs, not only after it exits.
func TestRunStreamsIncrementally(t *testing.T) {
	var mu sync.Mutex
	type chunk struct {
		at     time.Duration
		stream string
		data   string
	}
	var chunks []chunk

	start := time.Now()
	sink := func(stream, data string) {
		mu.Lock()
		defer mu.Unlock()
		chunks = append(chunks, chunk{time.Since(start), stream, data})
	}

	res, err := testExecutor().Run(context.Background(), protocol.Command{
		V:       protocol.Version,
		ID:      "stream-test",
		Command: `echo first; sleep 1; echo second; sleep 1; echo third`,
		Stream:  true,
	}, sink)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit %d", res.ExitCode)
	}

	mu.Lock()
	defer mu.Unlock()

	if len(chunks) < 2 {
		t.Fatalf("expected output in several chunks, got %d: %+v", len(chunks), chunks)
	}

	// The first chunk must land well before the ~2s total runtime.
	if chunks[0].at > 900*time.Millisecond {
		t.Errorf("first chunk arrived after %v; output was not streamed", chunks[0].at)
	}

	var b strings.Builder
	for _, c := range chunks {
		b.WriteString(c.data)
	}
	joined := b.String()
	for _, want := range []string{"first", "second", "third"} {
		if !strings.Contains(joined, want) {
			t.Errorf("streamed output missing %q; got %q", want, joined)
		}
	}
	if !strings.Contains(string(res.Stdout), "third") {
		t.Errorf("final capture incomplete: %q", res.Stdout)
	}
}

// stderr must be streamed too, and tagged separately.
func TestRunStreamsStderr(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]string{}
	sink := func(stream, data string) {
		mu.Lock()
		seen[stream] += data
		mu.Unlock()
	}

	_, err := testExecutor().Run(context.Background(), protocol.Command{
		V:       protocol.Version,
		ID:      "stderr-test",
		Command: `echo out; echo err 1>&2`,
		Stream:  true,
	}, sink)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(seen["stdout"], "out") {
		t.Errorf("stdout not streamed: %q", seen["stdout"])
	}
	if !strings.Contains(seen["stderr"], "err") {
		t.Errorf("stderr not streamed: %q", seen["stderr"])
	}
}

// With no sink the command still runs and captures normally.
func TestRunWithoutSink(t *testing.T) {
	res, err := testExecutor().Run(context.Background(), protocol.Command{
		V:       protocol.Version,
		ID:      "nosink",
		Command: "echo hello",
	}, nil)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !strings.Contains(string(res.Stdout), "hello") {
		t.Errorf("got %q", res.Stdout)
	}
}
