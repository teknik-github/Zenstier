package executor

import (
	"bytes"
	"sync"
	"time"
)

// ChunkSink receives incremental output while a command is still running.
// It must not block: the dispatcher publishes chunks at QoS 0 and returns.
type ChunkSink func(stream string, data string)

// chunkEmitter buffers writes and hands them to a sink in batches.
//
// Flushing on a size threshold alone would starve a command that trickles
// output; flushing on every write would publish one MQTT message per line.
// Both a size trigger and a time trigger are therefore needed.
type chunkEmitter struct {
	mu     sync.Mutex
	buf    bytes.Buffer
	stream string
	sink   ChunkSink
	max    int
	closed bool
}

func newChunkEmitter(stream string, max int, sink ChunkSink) *chunkEmitter {
	if max <= 0 {
		max = 32 * 1024
	}
	return &chunkEmitter{stream: stream, sink: sink, max: max}
}

func (e *chunkEmitter) Write(p []byte) (int, error) {
	if e.sink == nil {
		return len(p), nil
	}
	e.mu.Lock()
	e.buf.Write(p)
	full := e.buf.Len() >= e.max
	e.mu.Unlock()

	if full {
		e.Flush()
	}
	// Always report full consumption so the child never blocks on its pipe.
	return len(p), nil
}

// Flush emits whatever has accumulated. Safe to call concurrently and when empty.
func (e *chunkEmitter) Flush() {
	if e.sink == nil {
		return
	}
	e.mu.Lock()
	if e.buf.Len() == 0 || e.closed {
		e.mu.Unlock()
		return
	}
	data := e.buf.String()
	e.buf.Reset()
	e.mu.Unlock()

	e.sink(e.stream, data)
}

func (e *chunkEmitter) Close() {
	e.Flush()
	e.mu.Lock()
	e.closed = true
	e.mu.Unlock()
}

// startFlusher periodically drains the emitters until stop is closed.
func startFlusher(interval time.Duration, stop <-chan struct{}, emitters ...*chunkEmitter) {
	if interval <= 0 {
		interval = 500 * time.Millisecond
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				for _, e := range emitters {
					e.Flush()
				}
			}
		}
	}()
}
