#!/bin/sh
# Enrolls once on first boot, then runs the agent in the foreground.
set -eu

: "${ZENSTIER_TOKEN:?ZENSTIER_TOKEN is required}"
: "${ZENSTIER_SERVER:?ZENSTIER_SERVER is required}"

if [ ! -f /etc/zenstier/config.yaml ]; then
  echo "==> enrolling with ${ZENSTIER_SERVER}"
  zenstier enroll --token "$ZENSTIER_TOKEN" --server "$ZENSTIER_SERVER" --force
fi

exec zenstier run --config /etc/zenstier/config.yaml
