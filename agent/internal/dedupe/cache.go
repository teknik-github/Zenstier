// Package dedupe suppresses duplicate command delivery.
//
// MQTT QoS 1 is at-least-once: after a reconnect mid-handshake the broker will
// redeliver. Executing `reboot` twice is a real incident, so every command id
// is remembered along with its terminal result.
package dedupe

import (
	"sync"
	"time"
)

type entry struct {
	seen    time.Time
	result  []byte
	running bool
}

type Cache struct {
	mu       sync.Mutex
	entries  map[string]*entry
	order    []string
	capacity int
	ttl      time.Duration
}

func New(capacity int, ttl time.Duration) *Cache {
	if capacity <= 0 {
		capacity = 1024
	}
	if ttl <= 0 {
		ttl = time.Hour
	}
	return &Cache{
		entries:  make(map[string]*entry, capacity),
		capacity: capacity,
		ttl:      ttl,
	}
}

// Add records a command id. It reports false if the id was already known.
func (c *Cache) Add(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.evictLocked()

	if e, ok := c.entries[id]; ok && time.Since(e.seen) < c.ttl {
		return false
	}
	c.entries[id] = &entry{seen: time.Now(), running: true}
	c.order = append(c.order, id)
	return true
}

// Remove forgets an id so a rejected command can legitimately be retried.
func (c *Cache) Remove(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, id)
}

// Complete stores the terminal result so a duplicate can be answered with it.
func (c *Cache) Complete(id string, result []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.entries[id]; ok {
		e.result = result
		e.running = false
	}
}

// CachedResult returns the stored result, and whether the command is still running.
func (c *Cache) CachedResult(id string) (result []byte, running bool, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, exists := c.entries[id]
	if !exists {
		return nil, false, false
	}
	return e.result, e.running, true
}

func (c *Cache) evictLocked() {
	now := time.Now()
	for len(c.order) > 0 {
		oldest := c.order[0]
		e, ok := c.entries[oldest]
		overCapacity := len(c.entries) >= c.capacity
		if !ok {
			c.order = c.order[1:]
			continue
		}
		if now.Sub(e.seen) > c.ttl || overCapacity {
			delete(c.entries, oldest)
			c.order = c.order[1:]
			continue
		}
		break
	}
}
