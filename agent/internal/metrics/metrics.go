// Package metrics samples host resource usage from /proc and statfs.
//
// Everything is read directly from the kernel interfaces so the agent keeps a
// zero-dependency footprint and never shells out.
package metrics

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Sample is the resource snapshot carried on each heartbeat.
type Sample struct {
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

type cpuTimes struct {
	idle, total uint64
}

var (
	mu       sync.Mutex
	lastCPU  cpuTimes
	lastRead time.Time
)

// Collect samples the host. CPU percent is a delta against the previous call,
// so the first call after start reports 0.
func Collect() *Sample {
	s := &Sample{}

	if l, err := readLoad(); err == nil {
		s.Load1, s.Load5, s.Load15, s.Processes = l[0], l[1], l[2], int(l[3])
	}
	if total, available, err := readMem(); err == nil && total > 0 {
		s.MemTotalKB = total
		s.MemUsedKB = total - available
		s.MemPercent = round2(float64(s.MemUsedKB) / float64(total) * 100)
	}
	if total, used, err := readDisk("/"); err == nil && total > 0 {
		s.DiskTotalKB = total
		s.DiskUsedKB = used
		s.DiskPercent = round2(float64(used) / float64(total) * 100)
	}
	if up, err := readUptime(); err == nil {
		s.UptimeSec = up
	}
	s.CPUPercent = cpuPercent()

	return s
}

func cpuPercent() float64 {
	now, err := readCPU()
	if err != nil {
		return 0
	}

	mu.Lock()
	defer mu.Unlock()

	prev := lastCPU
	lastCPU, lastRead = now, time.Now()

	if prev.total == 0 || now.total <= prev.total {
		return 0
	}
	totalDelta := now.total - prev.total
	idleDelta := now.idle - prev.idle
	if totalDelta == 0 {
		return 0
	}
	return round2((1 - float64(idleDelta)/float64(totalDelta)) * 100)
}

func readCPU() (cpuTimes, error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return cpuTimes{}, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 5 || fields[0] != "cpu" {
			continue
		}
		var total, idle uint64
		for i, raw := range fields[1:] {
			v, err := strconv.ParseUint(raw, 10, 64)
			if err != nil {
				continue
			}
			total += v
			// fields: user nice system idle iowait irq softirq ...
			if i == 3 || i == 4 {
				idle += v
			}
		}
		return cpuTimes{idle: idle, total: total}, nil
	}
	return cpuTimes{}, scanner.Err()
}

func readLoad() ([4]float64, error) {
	var out [4]float64
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return out, err
	}
	fields := strings.Fields(string(b))
	if len(fields) < 4 {
		return out, nil
	}
	out[0], _ = strconv.ParseFloat(fields[0], 64)
	out[1], _ = strconv.ParseFloat(fields[1], 64)
	out[2], _ = strconv.ParseFloat(fields[2], 64)
	if running, _, ok := strings.Cut(fields[3], "/"); ok {
		if n, err := strconv.Atoi(running); err == nil {
			out[3] = float64(n)
		}
	}
	return out, nil
}

// readMem returns total and available memory in KiB. MemAvailable is the
// kernel's own estimate and is far more accurate than total-free.
func readMem() (total, available uint64, err error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		key, value, ok := strings.Cut(scanner.Text(), ":")
		if !ok {
			continue
		}
		fields := strings.Fields(value)
		if len(fields) == 0 {
			continue
		}
		n, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		switch key {
		case "MemTotal":
			total = n
		case "MemAvailable":
			available = n
		}
		if total > 0 && available > 0 {
			break
		}
	}
	return total, available, scanner.Err()
}

func readDisk(path string) (total, used uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	blockKB := uint64(st.Bsize) / 1024
	total = st.Blocks * blockKB
	// Use the non-root-reserved figure, matching what `df` reports as used.
	used = (st.Blocks - st.Bfree) * blockKB
	return total, used, nil
}

func readUptime() (uint64, error) {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 {
		return 0, nil
	}
	v, err := strconv.ParseFloat(fields[0], 64)
	return uint64(v), err
}

func round2(f float64) float64 {
	return float64(int(f*100+0.5)) / 100
}
