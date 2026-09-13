#!/usr/bin/env bash
# Spins up a containerised device enrolled against the local dashboard.
#
#   ./scripts/spawn-test-device.sh <device-name> [owner-email]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${1:?usage: spawn-test-device.sh <device-name> [owner-email]}"
# Falls back to the env var, then to whichever account exists — so the script
# works on any install rather than only the one it was written on.
OWNER="${2:-${ZENSTIER_OWNER_EMAIL:-}}"
CONTAINER="zenstier-dev-${NAME}"

LAN_IP="${ZENSTIER_LAN_IP:-$(ip -4 -o addr show scope global | awk 'NR==1{split($4,a,"/"); print a[1]}')}"
SERVER="http://${LAN_IP}:3020"

cd "$REPO_ROOT"

echo "==> building agent binary"
make -C agent build >/dev/null

echo "==> issuing enrollment token for ${NAME}${OWNER:+ (owner: ${OWNER})}"
TOKEN_JSON="$(pnpm exec tsx --conditions=react-server --tsconfig tsconfig.worker.json \
  scripts/e2e-token.ts "$OWNER" "$NAME" 2>/dev/null | tail -1)"
TOKEN="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['plaintextToken'])" "$TOKEN_JSON")"

echo "==> building device image"
cp agent/dist/zenstier-linux-amd64 infra/test-devices/zenstier
docker build -q -t zenstier-test-device infra/test-devices >/dev/null
rm -f infra/test-devices/zenstier

echo "==> starting ${CONTAINER}"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d \
  --name "$CONTAINER" \
  --hostname "$NAME" \
  --add-host "host.docker.internal:host-gateway" \
  -e ZENSTIER_TOKEN="$TOKEN" \
  -e ZENSTIER_SERVER="$SERVER" \
  --restart unless-stopped \
  zenstier-test-device >/dev/null

echo "==> ${CONTAINER} started (server: ${SERVER})"
