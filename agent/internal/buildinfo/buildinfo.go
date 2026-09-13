// Package buildinfo carries values stamped in at link time.
package buildinfo

// Overridden via -ldflags "-X .../buildinfo.Version=...".
var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)
