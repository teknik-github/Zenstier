package executor

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

// A short write count makes os/exec close the child's stdout pipe, killing it
// with SIGPIPE. Write must always report the full length it was handed.
func TestCapWriterReportsFullWriteLength(t *testing.T) {
	w := newCapWriter(64)

	for _, chunk := range [][]byte{
		[]byte("hello"),
		bytes.Repeat([]byte("x"), 500), // well past the cap
		[]byte("tail"),
	} {
		n, err := w.Write(chunk)
		if err != nil {
			t.Fatalf("Write returned error: %v", err)
		}
		if n != len(chunk) {
			t.Fatalf("Write reported %d bytes, want %d", n, len(chunk))
		}
	}
}

func TestCapWriterSatisfiesIoWriter(t *testing.T) {
	var w io.Writer = newCapWriter(128)
	if _, err := io.Copy(w, strings.NewReader(strings.Repeat("a", 10_000))); err != nil {
		t.Fatalf("io.Copy failed: %v", err)
	}
}

func TestCapWriterKeepsHeadAndTail(t *testing.T) {
	w := newCapWriter(20) // 10 head + 10 tail
	w.Write([]byte("HEADHEADHE"))
	w.Write([]byte(strings.Repeat("m", 100)))
	w.Write([]byte("TAILTAILTA"))

	out := string(w.Bytes())
	if !strings.HasPrefix(out, "HEADHEADHE") {
		t.Errorf("head not preserved: %q", out)
	}
	if !strings.HasSuffix(out, "TAILTAILTA") {
		t.Errorf("tail not preserved: %q", out)
	}
	if !w.Truncated() {
		t.Error("expected Truncated() to be true")
	}
	if !strings.Contains(out, "truncated") {
		t.Errorf("expected a truncation marker: %q", out)
	}
}

func TestCapWriterUntruncatedRoundTrip(t *testing.T) {
	w := newCapWriter(1024)
	w.Write([]byte("hello from zenstier\n"))
	if got := string(w.Bytes()); got != "hello from zenstier\n" {
		t.Errorf("got %q", got)
	}
	if w.Truncated() {
		t.Error("short output should not be marked truncated")
	}
}
