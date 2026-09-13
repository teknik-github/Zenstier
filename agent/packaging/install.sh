#!/bin/sh
# Zenstier agent installer.
#
#   curl -fsSL https://example.com/install.sh | sudo sh -s -- \
#       --token zst_ent_xxx --server https://zenstier.example.com
#
# Wrapped in main() so a truncated download cannot execute a partial script.
set -eu

BIN_DIR=/usr/local/bin
CONF_DIR=/etc/zenstier
STATE_DIR=/var/lib/zenstier
UNIT=/etc/systemd/system/zenstier.service

die() { echo "error: $*" >&2; exit 1; }

main() {
  TOKEN=""; SERVER=""; SOURCE=""; VERSION="latest"

  while [ $# -gt 0 ]; do
    case "$1" in
      --token)   TOKEN="$2"; shift 2 ;;
      --server)  SERVER="$2"; shift 2 ;;
      --source)  SOURCE="$2"; shift 2 ;;
      --version) VERSION="$2"; shift 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  [ "$(id -u)" = "0" ] || die "must run as root"
  [ -n "$TOKEN" ]  || die "--token is required"
  [ -n "$SERVER" ] || die "--server is required"
  [ -d /run/systemd/system ] || die "systemd is required"

  case "$(uname -m)" in
    x86_64|amd64)  ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  echo "==> Installing zenstier ($ARCH)"
  if [ -n "$SOURCE" ]; then
    # Local file or directory, for air-gapped installs.
    if [ -d "$SOURCE" ]; then
      cp "$SOURCE/zenstier-linux-$ARCH" "$TMP/zenstier"
    else
      cp "$SOURCE" "$TMP/zenstier"
    fi
  else
    URL="$SERVER/downloads/$VERSION/zenstier-linux-$ARCH"
    echo "    downloading $URL"
    curl -fsSL "$URL" -o "$TMP/zenstier" || die "download failed"
    # Verify the checksum when the server publishes one. An RMM installer is a
    # high-value supply-chain target; never skip this silently in production.
    if curl -fsSL "$SERVER/downloads/$VERSION/SHA256SUMS" -o "$TMP/SHA256SUMS" 2>/dev/null; then
      ( cd "$TMP" && grep "zenstier-linux-$ARCH" SHA256SUMS \
          | sed "s|zenstier-linux-$ARCH|zenstier|" | sha256sum -c - ) \
        || die "checksum verification failed"
      echo "    checksum verified"
    else
      echo "    WARNING: no SHA256SUMS published; skipping verification" >&2
    fi
  fi

  install -m 0755 -o root -g root "$TMP/zenstier" "$BIN_DIR/zenstier"
  install -d -m 0700 -o root -g root "$CONF_DIR"
  install -d -m 0750 -o root -g root "$STATE_DIR"

  # Enroll BEFORE enabling the service: a failed enrollment then leaves no
  # crash-looping daemon behind, only a binary.
  echo "==> Enrolling"
  "$BIN_DIR/zenstier" enroll --token "$TOKEN" --server "$SERVER" --force \
    || die "enrollment failed"

  echo "==> Installing systemd unit"
  cat > "$UNIT" <<'UNITEOF'
[Unit]
Description=Zenstier remote management agent
Documentation=https://github.com/zenstier/zenstier
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=exec
ExecStart=/usr/local/bin/zenstier run --config /etc/zenstier/config.yaml
User=root
Restart=always
RestartSec=5s
# Must exceed the agent's own 10s drain window for running commands.
TimeoutStopSec=30s
KillMode=mixed
KillSignal=SIGTERM

# Resource guards. These turn a runaway command from "the server dies" into
# "the agent's cgroup dies and systemd restarts it".
LimitNOFILE=8192
TasksMax=512
MemoryMax=512M
OOMScoreAdjust=-500

# Deliberately NOT sandboxed.
#
# systemd sandboxing (ProtectSystem=strict, PrivateTmp, NoNewPrivileges,
# SystemCallFilter, ...) is inherited by every process the agent spawns. On a
# general-purpose management agent that breaks the operations the product
# exists to perform: ProtectSystem=strict makes `apt install` fail, PrivateTmp
# hides files the admin expects in /tmp, NoNewPrivileges breaks sudo/su and
# every setuid binary, and SystemCallFilter=@system-service blocks mount,
# reboot and modprobe.
#
# It also provides little real defence: an attacker who can run commands here
# is already root and can escape with `systemd-run --scope`. Security comes
# from token-gated enrollment, per-device broker credentials with pattern
# ACLs, verified TLS, the 0600 config, and the server-side audit log.
#
# For monitoring-only deployments use zenstier-restricted.service instead.
ProtectClock=true

StandardOutput=journal
StandardError=journal
SyslogIdentifier=zenstier

[Install]
WantedBy=multi-user.target
UNITEOF
  chmod 0644 "$UNIT"
  systemctl daemon-reload
  systemctl enable --now zenstier

  sleep 2
  if systemctl is-active --quiet zenstier; then
    echo "✓ zenstier is running"
    "$BIN_DIR/zenstier" status
  else
    echo "✗ zenstier failed to start. Logs:" >&2
    journalctl -u zenstier -n 30 --no-pager >&2
    exit 1
  fi
}

main "$@"
