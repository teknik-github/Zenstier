#!/usr/bin/env bash
#
# Zenstier one-shot setup.
#
#   ./scripts/bootstrap.sh                 # full setup
#   ./scripts/bootstrap.sh --reset-env     # regenerate .env (rotates secrets)
#
# Idempotent: safe to re-run. An existing .env is reused so secrets stay put.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

RESET_ENV=0
for arg in "$@"; do
  case "$arg" in
    --reset-env) RESET_ENV=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) die "unknown argument: $arg" ;;
  esac
done

# ── 1. Prerequisites ────────────────────────────────────────────────────────
bold "==> Checking prerequisites"
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"; }
need docker
need openssl
need node
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js >= 20.9 is required (found $(node -v))"

if ! command -v pnpm >/dev/null 2>&1; then
  warn "pnpm not found — enabling it via corepack"
  corepack enable >/dev/null 2>&1 || die "install pnpm: npm i -g pnpm"
fi
ok "docker, openssl, node $(node -v), pnpm $(pnpm -v)"

# ── 2. Environment ──────────────────────────────────────────────────────────
bold "==> Environment"
gen() { openssl rand -base64 "${1:-24}" | tr -d '/+=\n' | cut -c1-"${2:-32}"; }

# Prefer a routable address so agents on other machines can reach the broker.
LAN_IP="${ZENSTIER_LAN_IP:-$(ip -4 -o addr show scope global 2>/dev/null | awk 'NR==1{split($4,a,"/"); print a[1]}')}"
LAN_IP="${LAN_IP:-localhost}"

if [ -f .env ] && [ "$RESET_ENV" = "0" ]; then
  ok ".env already exists — keeping current secrets (--reset-env to rotate)"
else
  [ -f .env ] && cp .env ".env.backup.$(date +%s)" && warn "existing .env backed up"
  PG_PASS="$(gen 24 32)"
  cat > .env <<ENVEOF
POSTGRES_USER=zenstier
POSTGRES_PASSWORD=${PG_PASS}
POSTGRES_DB=zenstier
DATABASE_URL="postgresql://zenstier:${PG_PASS}@localhost:5480/zenstier?schema=public"

AUTH_SECRET=$(openssl rand -base64 32)
AUTH_TRUST_HOST=true

MQTT_URL=mqtts://localhost:8883
MQTT_CA_FILE=./infra/mosquitto/certs/ca.crt
MQTT_BACKEND_USERNAME=zenstier-server
MQTT_BACKEND_PASSWORD=$(gen 24 32)
MQTT_PROVISIONER_USERNAME=zenstier-provisioner
MQTT_PROVISIONER_PASSWORD=$(gen 24 32)
MQTT_ADMIN_USERNAME=admin
MQTT_ADMIN_PASSWORD=$(gen 24 32)

REDIS_URL=redis://localhost:6385

AGENT_MQTT_HOST=${LAN_IP}
AGENT_MQTT_PORT=8883

COMMAND_RATE_LIMIT_PER_MINUTE=30
ENVEOF
  chmod 600 .env
  ok "generated .env with fresh secrets (0600), agents will dial ${LAN_IP}:8883"
fi

# ── 3. Dependencies ─────────────────────────────────────────────────────────
bold "==> Installing dependencies"
pnpm install --silent
ok "node modules installed"

# ── 4. TLS ──────────────────────────────────────────────────────────────────
bold "==> TLS certificates"
if [ -f infra/mosquitto/certs/server.crt ]; then
  ok "certificates already present"
else
  ZENSTIER_LAN_IP="$LAN_IP" ./infra/certs/gen-dev-ca.sh >/dev/null
  ok "development CA + broker certificate generated (SAN includes ${LAN_IP})"
fi

# ── 5. Infrastructure ───────────────────────────────────────────────────────
bold "==> Starting Postgres, Redis and Mosquitto"
docker compose up -d >/dev/null
printf '  waiting for health'
for _ in $(seq 1 60); do
  UNHEALTHY="$(docker compose ps --format '{{.Health}}' 2>/dev/null | grep -cv '^healthy$' || true)"
  [ "${UNHEALTHY:-1}" = "0" ] && break
  printf '.'; sleep 2
done
echo
docker compose ps --format '  {{.Name}}  {{.Status}}'

# ── 6. Database ─────────────────────────────────────────────────────────────
bold "==> Database"
pnpm exec prisma migrate deploy 2>&1 | grep -E 'migration|applied|up to date' | tail -3 || true
pnpm exec prisma generate >/dev/null
ok "schema applied and client generated"

# ── 7. Broker roles ─────────────────────────────────────────────────────────
bold "==> Seeding broker roles and service accounts"
pnpm dynsec:seed 2>&1 | grep -E '^\s+[+=]|seeded' | tail -8
ok "dynamic security configured"

# ── 8. First account ────────────────────────────────────────────────────────
bold "==> Dashboard account"
if [ -n "${ZENSTIER_ADMIN_EMAIL:-}" ] && [ -n "${ZENSTIER_ADMIN_PASSWORD:-}" ]; then
  pnpm user:create "$ZENSTIER_ADMIN_EMAIL" "$ZENSTIER_ADMIN_PASSWORD" "${ZENSTIER_ADMIN_NAME:-Admin}" 2>&1 | tail -1
else
  warn "no ZENSTIER_ADMIN_EMAIL/PASSWORD set — register at /register instead"
fi

cat <<DONE

$(bold "Zenstier is ready.")

  Start it:      pnpm start:all          (dashboard + MQTT worker)
  Or in dev:     pnpm dev

  Dashboard:     http://${LAN_IP}:3020
  Create an account at /register, then add a device under Devices.

  Build agents:  pnpm agent:build         -> agent/dist/zenstier-linux-{amd64,arm64}
  Verify setup:  pnpm dynsec:verify       (broker isolation + revocation)
                 pnpm rbac:verify         (permission escalation)

  Secrets live in .env (mode 0600) and are never committed.
DONE
