// Command zenstier is the Zenstier agent and its setup CLI.
//
// One binary rather than two: the enroll and daemon paths share the config
// struct, host-fact collection and TLS setup, and a single file makes the
// install script, upgrades and support dramatically simpler.
package main

import (
	"fmt"
	"os"

	"github.com/zenstier/agent/internal/buildinfo"
	"github.com/zenstier/agent/internal/cli"
)

func usage() {
	fmt.Fprintf(os.Stderr, `zenstier %s — remote management agent

Usage:
  zenstier <command> [flags]

Commands:
  enroll      Register this host using a dashboard token
  run         Run the agent in the foreground (used by systemd)
  status      Show local agent state
  uninstall   Remove local agent configuration
  version     Print version information

Run "zenstier <command> -h" for command flags.
`, buildinfo.Version)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	command, args := os.Args[1], os.Args[2:]
	var err error

	switch command {
	case "enroll":
		err = cli.Enroll(args)
	case "run":
		err = cli.Run(args)
	case "status":
		err = cli.Status(args)
	case "uninstall":
		err = cli.Uninstall(args)
	case "version", "--version", "-v":
		fmt.Printf("zenstier %s (commit %s, built %s)\n",
			buildinfo.Version, buildinfo.Commit, buildinfo.Date)
	case "help", "-h", "--help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", command)
		usage()
		os.Exit(2)
	}

	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
