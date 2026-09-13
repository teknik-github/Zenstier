# Installing Zenstier

Two parts: the **server** (dashboard, broker, worker) and the **agent** you put
on each managed machine.

---

## 1. Server

### Requirements

| Need | Minimum | Why |
|---|---|---|
| Docker + Compose v2 | any recent | Postgres, Redis and Mosquitto run as containers |
| Node.js | 20.9 | required by Next.js 16 |
| pnpm | 9 | `corepack enable` installs it |
| OpenSSL | 1.1+ | generates the development CA |

A Go toolchain is **not** needed — agents build inside a container.

### One command

```bash
git clone https://github.com/<you>/zenstier.git
cd zenstier
./scripts/bootstrap.sh
```

That script is idempotent and does the whole setup:

1. checks prerequisites
2. writes `.env` with freshly generated secrets (mode `0600`)
3. installs dependencies
4. generates a development CA and broker certificate
5. starts Postgres, Redis and Mosquitto, waiting for health
6. applies migrations and generates the Prisma client
7. seeds the broker's roles and the two service accounts

Create the first account in one go if you prefer:

```bash
ZENSTIER_ADMIN_EMAIL=you@example.com \
ZENSTIER_ADMIN_PASSWORD='a-strong-password' \
./scripts/bootstrap.sh
```

Then run it:

```bash
pnpm start:all      # dashboard on :3020 + MQTT ingest worker
# or during development
pnpm dev
```

Open `http://<host>:3020` and register.

### Reachability matters

`AGENT_MQTT_HOST` in `.env` is the address agents dial, and it must match a SAN
on the broker certificate. `bootstrap.sh` detects your LAN IP and uses it. If
your machines reach the server by DNS name instead, set it before running:

```bash
ZENSTIER_LAN_IP=zenstier.example.com ./scripts/bootstrap.sh
```

Changing it later means regenerating certificates:

```bash
FORCE=1 ZENSTIER_LAN_IP=zenstier.example.com ./infra/certs/gen-dev-ca.sh
docker compose restart mosquitto
```

### Verify the install

```bash
pnpm dynsec:verify   # 15 assertions: device isolation, wildcard escapes, live revocation
pnpm rbac:verify     # 14 assertions: privilege escalation, team isolation
```

Both should report `0 failed`. They are worth running after any change to
`infra/mosquitto/` or the permission model.

### Ports

| Service | Port | Exposure |
|---|---|---|
| Dashboard | 3020 | `0.0.0.0` |
| Mosquitto MQTTS | 8883 | `0.0.0.0` — agents connect here |
| PostgreSQL | 5480 | loopback only |
| Redis | 6385 | loopback only |

Mosquitto's plaintext 1883 listener is bound to the container's loopback and is
never published: it exists only for the healthcheck.

---

## 2. Agent

### Build

```bash
pnpm agent:build     # -> agent/dist/zenstier-linux-{amd64,arm64}
```

Cross-compiles both architectures inside the `golang` image. The output is a
static binary with no runtime dependencies.

### Install on a machine

1. In the dashboard: **Devices → Enroll a new device**. Copy the command shown
   — the token appears **once**.
2. Copy the binary to the target and run the installer:

```bash
sudo ./install.sh --token zst_ent_... --server http://<dashboard>:3020 \
     --source ./zenstier-linux-amd64
```

`agent/packaging/install.sh` verifies the checksum when the server publishes
one, installs to `/usr/local/bin/zenstier`, enrolls, writes
`/etc/zenstier/config.yaml` (`0600`, root-owned) and enables the systemd unit.

Enrollment happens **before** the service is enabled, so a failure leaves a
binary behind rather than a crash-looping daemon.

### Manual install

```bash
sudo install -m 0755 zenstier-linux-amd64 /usr/local/bin/zenstier
sudo zenstier enroll --token zst_ent_... --server http://<dashboard>:3020
sudo install -m 0644 zenstier.service /etc/systemd/system/
sudo systemctl enable --now zenstier
zenstier status
```

### Which unit file?

- **`zenstier.service`** — the default. Runs as root and is deliberately *not*
  systemd-sandboxed: sandboxing is inherited by every spawned command, so
  `ProtectSystem=strict` breaks `apt`, `NoNewPrivileges` breaks `sudo`, and
  `SystemCallFilter` blocks `mount` and `reboot`. It would break the operations
  the product exists to perform while barely inconveniencing an attacker who
  already has command execution.
- **`zenstier-restricted.service`** — hardened, for monitoring-only fleets.
  Administrative commands *will* fail under it. That is the trade.

### Uninstall

```bash
sudo zenstier uninstall
sudo systemctl disable --now zenstier
sudo rm /etc/systemd/system/zenstier.service
```

---

## 3. Try it without real machines

Throwaway devices as containers — a normal Debian userland with the agent
installed, so commands behave as they would on a real host:

```bash
./scripts/spawn-test-device.sh web-01
./scripts/spawn-test-device.sh db-01
docker rm -f zenstier-dev-web-01     # tear one down
```

---

## Optional: AI console

Any OpenAI-compatible endpoint. Add to `.env` and restart:

```bash
AI_BASE_URL=https://api.deepseek.com   # or OpenAI, Ollama, vLLM…
AI_API_KEY=sk-...
AI_MODEL=deepseek-chat
AI_RATE_LIMIT_PER_HOUR=60
```

The assistant drafts commands and explains output; it cannot run anything.
Every proposal needs a human click, and running it goes through the same
permission, rate limit and audit trail as a hand-typed command.

Grant the `ai:use` permission under **Team → Roles & permissions**. Owner,
Admin and Operator receive it by default.

> Adding a permission to the catalogue does not retroactively grant it to roles
> that were seeded by an older version. If you add your own permissions later,
> ship an additive SQL migration the way
> `prisma/migrations/*_grant_ai_use_to_system_roles` does.

## Production notes

The default setup is a **development** one. Before exposing it:

- **Replace the self-signed CA.** Use an ACME certificate for the broker
  (DNS-01; HTTP-01 is awkward alongside a broker) and point `certfile` at
  `fullchain.pem`, not the leaf. Reload with `docker kill -s HUP
  zenstier-mosquitto` from a certbot deploy hook.
- **Terminate TLS in front of the dashboard.** `proxy.ts` only sends HSTS and
  `upgrade-insecure-requests` when the request actually arrives over HTTPS, so
  put it behind a reverse proxy that sets `X-Forwarded-Proto`.
- **Exclude `/api/events` from proxy buffering and compression** — it is an SSE
  stream. nginx: `proxy_buffering off;` and leave `gzip` off for that location.
  The app already sends `X-Accel-Buffering: no` and disables Next's compression.
- **Rotate the secrets** `bootstrap.sh` generated if the host was ever shared,
  with `./scripts/bootstrap.sh --reset-env` followed by `pnpm dynsec:seed`.
- **Back up Postgres.** It holds the audit trail, which is the point of the
  product.

## Troubleshooting

**Agents connect then immediately drop.** Their credential was revoked, or a
second agent is using the same device id. Check `docker compose logs mosquitto`
for `not authorised`.

**Dashboard loads but shows no live updates.** The MQTT worker is a separate
process — make sure `pnpm start:all` (not just `next start`) is running, and
that Redis is reachable.

**Commands stay "queued" forever.** The device is offline, or the worker is
down. `pnpm dynsec:verify` confirms the broker path independently.

**Browser forces HTTPS on a plain-HTTP LAN address.** An old HSTS entry.
Clear it at `chrome://net-internals/#hsts`.
