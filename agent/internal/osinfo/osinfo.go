// Package osinfo collects host facts without shelling out.
package osinfo

import (
	"bufio"
	"os"
	"runtime"
	"strings"
	"sync"

	"github.com/zenstier/agent/internal/protocol"
)

var (
	once   sync.Once
	cached protocol.OSInfo
)

// Cached collects host facts once and reuses them for the process lifetime.
func Cached() *protocol.OSInfo {
	once.Do(func() { cached = collect() })
	c := cached
	return &c
}

func collect() protocol.OSInfo {
	info := protocol.OSInfo{Arch: runtime.GOARCH}

	if host, err := os.Hostname(); err == nil {
		info.Hostname = host
	} else if b, err := os.ReadFile("/etc/hostname"); err == nil {
		info.Hostname = strings.TrimSpace(string(b))
	}

	// Kernel release without pulling in golang.org/x/sys.
	if b, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		info.Kernel = strings.TrimSpace(string(b))
	}

	for _, path := range []string{"/etc/os-release", "/usr/lib/os-release"} {
		if fields, err := parseOSRelease(path); err == nil {
			info.Distro = fields["ID"]
			info.VersionID = fields["VERSION_ID"]
			info.Pretty = fields["PRETTY_NAME"]
			break
		}
	}

	return info
}

func parseOSRelease(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	out := make(map[string]string)
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		out[strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(value), `"'`)
	}
	return out, scanner.Err()
}

// MachineID returns a stable host identifier. The raw machine-id is treated as
// sensitive, so callers hash it before transmission.
func MachineID() string {
	for _, path := range []string{
		"/etc/machine-id",
		"/var/lib/dbus/machine-id",
		"/sys/class/dmi/id/product_uuid",
	} {
		if b, err := os.ReadFile(path); err == nil {
			if id := strings.TrimSpace(string(b)); id != "" {
				return id
			}
		}
	}
	return ""
}

// BootID changes on every reboot, letting the backend tell a restart from a
// flapping network link.
func BootID() string {
	if b, err := os.ReadFile("/proc/sys/kernel/random/boot_id"); err == nil {
		return strings.TrimSpace(string(b))
	}
	return ""
}
