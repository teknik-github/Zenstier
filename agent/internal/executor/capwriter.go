package executor

import "bytes"

// capWriter bounds captured output while ALWAYS consuming everything written.
//
// If it stopped consuming (or returned an error) once full, the child would
// block forever writing into a full pipe, turning "noisy command" into "hung
// worker". It keeps the head and a ring of the tail, because the interesting
// part of a failing command is usually the end.
type capWriter struct {
	head    bytes.Buffer
	tail    []byte
	tailPos int
	max     int
	total   int
}

func newCapWriter(max int) *capWriter {
	if max <= 0 {
		max = 1 << 20
	}
	half := max / 2
	return &capWriter{max: max, tail: make([]byte, 0, half)}
}

func (w *capWriter) Write(p []byte) (int, error) {
	// io.Writer requires reporting the full length consumed. Returning a short
	// count makes os/exec's copier treat it as io.ErrShortWrite, close the
	// pipe, and the child then dies with SIGPIPE (exit 141).
	n := len(p)
	w.total += n
	half := w.max / 2

	// Fill the head first.
	if w.head.Len() < half {
		n := half - w.head.Len()
		if n > len(p) {
			n = len(p)
		}
		w.head.Write(p[:n])
		p = p[n:]
	}
	if len(p) == 0 {
		return n, nil
	}

	// Everything after the head goes into a fixed-size ring holding the tail.
	for _, b := range p {
		if len(w.tail) < half {
			w.tail = append(w.tail, b)
			continue
		}
		w.tail[w.tailPos] = b
		w.tailPos = (w.tailPos + 1) % half
	}
	return n, nil
}

func (w *capWriter) Truncated() bool { return w.total > w.head.Len()+len(w.tail) }

func (w *capWriter) Dropped() int {
	d := w.total - w.head.Len() - len(w.tail)
	if d < 0 {
		return 0
	}
	return d
}

// Bytes returns head + marker + tail, in chronological order.
func (w *capWriter) Bytes() []byte {
	if !w.Truncated() {
		out := make([]byte, 0, w.head.Len()+len(w.tail))
		out = append(out, w.head.Bytes()...)
		return append(out, w.orderedTail()...)
	}
	marker := []byte("\n...[" + itoa(w.Dropped()) + " bytes truncated]...\n")
	out := make([]byte, 0, w.head.Len()+len(marker)+len(w.tail))
	out = append(out, w.head.Bytes()...)
	out = append(out, marker...)
	return append(out, w.orderedTail()...)
}

// orderedTail unrolls the ring buffer back into chronological order.
func (w *capWriter) orderedTail() []byte {
	half := w.max / 2
	if len(w.tail) < half {
		return w.tail
	}
	out := make([]byte, 0, len(w.tail))
	out = append(out, w.tail[w.tailPos:]...)
	return append(out, w.tail[:w.tailPos]...)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
