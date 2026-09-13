# Zenstier

Centralised remote command execution for infrastructure you own or are
authorised to administer — the same category of tool as MeshCentral, Tactical
RMM or Ansible AWX.

Enrollment is consent-based by construction: installing an agent requires root
on the target machine **and** a one-time token generated from the owner's own
dashboard. Every command is attributed and recorded.

## Architecture

```
┌──────────────┐   Server Actions    ┌─────────────────────────────┐
│   Browser    │◄───────────────────►│  Next.js 16 dashboard       │
│              │◄─── SSE ────────────│  (auth, API, dispatch)      │
└──────────────┘   /api/events       └──────────┬──────────────────┘
                                                │ publish (QoS 1)
        ┌───────────────────────────────────────┼──────────────┐
        │                                       ▼              │
        │  Redis  ◄── pub/sub ──  MQTT worker ──► Mosquitto 2.1 │
        │  (bus + rate limit)     (ingest)        MQTTS :8883   │
        └────────────────────┬──────────────────────┬──────────┘
                             │                      │
                        PostgreSQL            Go agents (systemd)
                     (state + audit)          one per device
```

**Four components**

| Component | Stack | Role |
|---|---|---|
| Dashboard | Next.js 16, React 19, Prisma 7, Auth.js v5, shadcn/ui | UI, auth, command dispatch, audit |
| Broker | Mosquitto 2.1 (Docker) | MQTTS transport, per-device credentials + ACLs |
| Worker | Node (tsx), separate process | Persistent MQTT subscriber → Postgres → Redis → SSE |
| Agent | Go, single static binary | Enrollment CLI + systemd daemon that executes commands |

### Single writer, enforced by the broker

The worker connects with a **fixed MQTT client id** (`zenstier-worker`). MQTT
brokers evict an existing session when a new client connects with the same id,
so accidentally starting a second worker kicks the first rather than leaving
two processes writing the same rows. Set `ZENSTIER_WORKER_ID` only when
deliberately sharding.

Both sides are also written to tolerate out-of-order delivery: MQTT gives no
ordering guarantee across messages, so a late `accepted(running)` must never
overwrite a command that already has its terminal result. That rule is enforced
in the worker (a conditional `updateMany`) and again in the browser reducer.

### Why the worker is a separate process

It is the single writer of inbound facts. Running the MQTT client inside
Next.js would open one subscription per server instance (duplicate writes and
racing status updates), accumulate connections across dev HMR, and also execute
inside build/prerender workers. Browser fan-out therefore goes through Redis
pub/sub, which is needed for distributed rate limiting anyway.

### MQTT topics

```
zenstier/{device_id}/command             server → device   (QoS 1)
zenstier/{device_id}/result              device → server   (QoS 1)
zenstier/{device_id}/status              device → server   (QoS 1, retained + LWT)
zenstier/broadcast/{group_id}/command    server → group    (QoS 1)
```

## Broadcast groups

A group gets its own dynsec role and dynsec group, so members may **receive**
on `zenstier/broadcast/{groupId}/command` and nothing more — no
`publishClientSend` is granted anywhere under `broadcast/**`, so a compromised
device can never fan a command out to its peers.

One publish then reaches the whole group. The payload carries only the batch
id; each agent derives its own command id with
`uuidv5("{batchId}:{deviceId}")`, matching rows the server inserted before
publishing. That keeps per-device audit history intact with a single message,
and the derivation is pinned by golden tests on both sides
(`agent/internal/protocol/uuid_test.go`).

Two non-obvious pieces make this reliable:

- **Membership is pushed on every connect.** Changing a device's group makes
  the broker kick it (dynsec drops clients it modifies), so an `update_groups`
  published at that moment is lost — the session is clean and nothing queues.
  The worker therefore re-asserts membership whenever a device reports online,
  and the agent's subscriptions converge on the database regardless.
- **The agent persists the new group list**, so a restart does not silently
  fall back to whatever was written at enrollment.

Per-device fan-out remains the default in the console; broadcast is opt-in via
`use group <name>` or the group chips in the target picker.

## Security model

- **MQTTS everywhere.** Devices reach the broker only on TLS 8883. Plaintext
  1883 is bound to container loopback for healthchecks.
- **One credential per device**, provisioned through Mosquitto's Dynamic
  Security plugin. ACLs use `%u` pattern substitution so a single role isolates
  the whole fleet: a device can subscribe only to `zenstier/%u/command` and
  publish only to its own `result`/`status`. It cannot publish to *any* command
  topic, including its own.
- **Revocation kills live sessions.** `deleteClient` removes the account and
  disconnects the connected client, so access ends in under a second rather
  than at the agent's next reconnect. Verified by `pnpm dynsec:verify`.
- **Split backend identities.** `zenstier-server` (data plane) cannot mint
  credentials; `zenstier-provisioner` (control plane) cannot read a single
  command result.
- **Enrollment tokens are not MQTT passwords.** The token is short-lived,
  single-use and human-visible; it is exchanged over HTTPS for a long-lived,
  machine-only broker credential.
- **Auth is enforced per call.** `proxy.ts` only does an optimistic cookie
  redirect; every Server Action and Route Handler re-checks the session,
  because Server Actions are reachable by direct POST.
- **Rate limiting** is an atomic Redis token bucket, per user and per device. A
  broadcast spends one user token per target so it cannot bypass the limit.

Run the security suite (15 assertions covering isolation, wildcard escapes,
command injection and live revocation):

```bash
pnpm dynsec:verify
```

## Teams and RBAC

Everything is owned by a **team**, never by a bare user account, so access is
granted and revoked purely by membership. Each user gets a personal team on
registration.

A **role** is just a named set of permission slugs, which is what makes the
model composable: an admin can build exactly the access a person needs instead
of picking from fixed tiers. Four system roles are seeded per team — Owner
(100), Admin (80), Operator (50), Viewer (10) — and any number of custom roles
can be added.

**Rank is the authority rule.** A member can only create, assign, edit or
delete roles ranked *below* their own, and can never act on an equal or senior
member. Without it, anyone holding `team:manage_roles` could edit their own
role and grant themselves everything. This is enforced in the service layer,
not just hidden in the UI — see `pnpm rbac:verify`.

A user can belong to several teams and switch between them from the sidebar;
the switcher also creates new ones. Switching re-scopes every query, so the
device list, console targets, history and audit log all change with it.

Permissions: `device:read|create|update|revoke|delete`,
`command:read|execute`, `audit:read`,
`team:read|manage_members|manage_roles|manage_settings`.

## Broadcast groups

A group gets its own dynsec role and dynsec group, so members may **receive**
on `zenstier/broadcast/{groupId}/command` and nothing more — no
`publishClientSend` is granted anywhere under `broadcast/**`, so a compromised
device can never fan a command out to its peers.

One publish then reaches the whole group. The payload carries only the batch
id; each agent derives its own command id with
`uuidv5("{batchId}:{deviceId}")`, matching rows the server inserted before
publishing. That keeps per-device audit history intact with a single message,
and the derivation is pinned by golden tests on both sides
(`agent/internal/protocol/uuid_test.go`).

Two non-obvious pieces make this reliable:

- **Membership is pushed on every connect.** Changing a device's group makes
  the broker kick it (dynsec drops clients it modifies), so an `update_groups`
  published at that moment is lost — the session is clean and nothing queues.
  The worker therefore re-asserts membership whenever a device reports online,
  and the agent's subscriptions converge on the database regardless.
- **The agent persists the new group list**, so a restart does not silently
  fall back to whatever was written at enrollment.

Per-device fan-out remains the default in the console; broadcast is opt-in via
`use group <name>` or the group chips in the target picker.

## Security

Zenstier executes root shell commands by design, so the controls that matter
are the ones deciding *who* may trigger execution and *which* machine receives
it.

| Control | Where |
|---|---|
| Per-device broker credentials, `%u`-scoped ACLs | Mosquitto dynamic security |
| Revocation kills the live TCP session | `deleteClient` + kicklist |
| Team-scoped queries (no cross-tenant reads) | every service and page |
| Permission check inside every Server Action | `requirePermission()` |
| Rank-based authority for role/member changes | `team.service.ts` |
| Deleting a team revokes every device credential first | `deleteTeam()` |
| Failed-login limit (8/account, 20/IP per 15 min) | `auth.ts` `authorize()` |
| Enrollment attempt limit (20/IP per 10 min) | `/api/v1/agent/enroll` |
| Command rate limit per user and per device | Redis token bucket |
| CSP with per-request nonce, HSTS, frame-ancestors none | `proxy.ts` |
| TLS verification always on, no skip-verify knob | agent + worker |
| Secrets hashed; plaintext shown exactly once | tokens, invites, MQTT passwords |

Two suites assert these rather than assuming them:

```bash
pnpm dynsec:verify   # 15 broker isolation + live-revocation assertions
pnpm rbac:verify     # 14 privilege-escalation and tenancy assertions
```

Brute-force limiting lives inside the Auth.js `authorize()` callback, not in
the login Server Action, because `/api/auth/callback/credentials` is reachable
by direct POST and would otherwise bypass it. The limiter fails **closed** on
auth paths: if Redis is unavailable the attempt is rejected.

It charges only **failed** attempts and clears the account's budget on a
correct password. Counting every attempt would lock out someone who simply
signs in often, which is a availability bug wearing a security costume.

CSP uses a per-request nonce, which requires dynamic rendering — `/login` and
`/register` call `connection()` for exactly that reason. `style-src` keeps
`unsafe-inline` because Tailwind and `next/font` emit inline `<style>`; inline
CSS is a far weaker vector than inline JS, which is nonce-gated.

### Known limitations

- Agents run as root and are deliberately **not** systemd-sandboxed; see the
  note in `agent/packaging/zenstier.service`.
- There is no per-command approval workflow or command allowlist yet.

- `mysql2` / `deepmerge-ts` are pinned forward in `pnpm-workspace.yaml`; they
  arrive via the Prisma CLI and are not on any runtime path here.

## Quick start

Requires Docker, Node >= 20.9 and pnpm. A Go toolchain is **not** needed — the
agent builds inside a container.

```bash
./scripts/bootstrap.sh    # secrets, certs, containers, migrations, broker roles
pnpm start:all            # dashboard on :3020 + MQTT worker
```

The script is idempotent and generates `.env` with fresh random secrets. Then
register at `http://<host>:3020/register`.

**[INSTALL.md](INSTALL.md)** covers agent installation, production hardening
and troubleshooting in full.

### Enrolling a device

1. Dashboard → **Devices** → add one. Copy the install command shown **once**.
2. Build the agent: `pnpm agent:build` → `agent/dist/zenstier-linux-{amd64,arm64}`.
3. Copy the binary to the target and run:

```bash
sudo zenstier enroll --token zst_ent_... --server http://<dashboard>:3020
sudo cp agent/packaging/zenstier.service /etc/systemd/system/
sudo systemctl enable --now zenstier
```

`agent/packaging/install.sh` automates all of this.

### Containerised test devices

For local development you can enroll throwaway devices as Docker containers —
a normal Debian userland with the agent installed, so commands behave as they
would on a real host:

```bash
./scripts/spawn-test-device.sh web-01          # owner defaults to the first admin
./scripts/spawn-test-device.sh db-01 you@example.com
docker rm -f zenstier-dev-web-01               # tear one down
```

Each container enrolls itself on first boot and then runs the agent in the
foreground under `--restart unless-stopped`.

## Layout

```
src/
  app/                    routes; _actions/ holds Server Actions
  components/             UI (ui/ = shadcn primitives)
  server/
    config/               zod-validated env
    infrastructure/       db, mqtt, events bus, ratelimit, logger
    modules/              auth, devices, tokens, commands (service + repo)
    worker/               MQTT ingest process
  lib/protocol.ts         MQTT wire contract (mirrors agent/internal/protocol)
prisma/                   schema + migrations
infra/                    mosquitto config, TLS generation
agent/                    Go module (cmd/, internal/, packaging/)
scripts/                  dynsec seeding, ACL verification, e2e helpers
```

The wire format is defined twice — `src/lib/protocol.ts` and
`agent/internal/protocol` — and **must** be changed in lockstep.

## Operational notes

- `compress: false` in `next.config.ts` is required: gzip buffers SSE until a
  chunk boundary. Behind nginx, exclude `/api/events` from compression.
- Agents use `CleanSession=true` deliberately. Persistent sessions would make a
  device that was offline for hours reconnect and immediately execute a backlog
  of root commands whose context is long gone. Queueing belongs in Postgres,
  where an operator can still cancel.
- Presence is fenced by `session_id` so a late Last-Will from a superseded
  session cannot mark a healthy device offline. The worker also suppresses
  offline transitions for ~2 minutes after detecting a broker restart.
- The default `zenstier.service` is intentionally not systemd-sandboxed:
  sandboxing is inherited by spawned commands and would break `apt`, `mount`,
  `sudo` and reboots. Use `zenstier-restricted.service` for monitoring-only
  deployments.

## Ports

| Service | Port |
|---|---|
| Dashboard | 3020 |
| PostgreSQL | 5480 (loopback) |
| Redis | 6385 (loopback) |
| Mosquitto MQTTS | 8883 |

## Resource monitoring

Agents attach a resource sample to every heartbeat (default 30s), read straight
from `/proc` and `statfs` with no extra dependencies: CPU percent (delta across
samples), memory via `MemAvailable`, root filesystem usage, load averages,
process count and uptime. The worker stores these in `device_metrics` and
pushes them over SSE, so the overview chart and the per-device meters update
live.
