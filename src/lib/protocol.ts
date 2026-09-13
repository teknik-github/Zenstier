/**
 * Zenstier MQTT wire protocol.
 *
 * This is the contract between the Next.js backend and the Go agent
 * (mirrored in agent/internal/protocol). Any change here MUST be mirrored
 * there and the version bumped.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

// ── Topics ──────────────────────────────────────────────────────────────────

export const topics = {
  command: (deviceId: string) => `zenstier/${deviceId}/command`,
  result: (deviceId: string) => `zenstier/${deviceId}/result`,
  status: (deviceId: string) => `zenstier/${deviceId}/status`,
  broadcastCommand: (groupId: string) =>
    `zenstier/broadcast/${groupId}/command`,
  // Wildcards used by the backend worker.
  allResults: "zenstier/+/result",
  allStatus: "zenstier/+/status",
} as const;

/** Extracts the device id from `zenstier/{deviceId}/(result|status)`. */
export function deviceIdFromTopic(topic: string): string | null {
  const parts = topic.split("/");
  if (parts.length !== 3 || parts[0] !== "zenstier") return null;
  if (parts[1] === "broadcast") return null;
  return parts[1] || null;
}

// ── Command (backend → agent) ───────────────────────────────────────────────

export const commandTypeSchema = z.enum([
  "exec",
  "cancel",
  "ping",
  "collect_facts",
  /** Pushes a new broadcast-group membership list to the agent. */
  "update_groups",
]);

export const commandPayloadSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  type: commandTypeSchema.default("exec"),
  issued_at: z.string(),
  expires_at: z.string(),
  issued_by: z.string().optional(),
  command: z.string().default(""),
  shell: z.string().optional(),
  work_dir: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  run_as: z.string().optional(),
  timeout_sec: z.number().int().positive().optional(),
  stream: z.boolean().default(false),
  max_output_bytes: z.number().int().positive().optional(),
  /** Present only for type = "cancel". */
  target_id: z.string().optional(),
  /** Present only for type = "update_groups". */
  groups: z.array(z.string()).optional(),
});

export type CommandPayload = z.infer<typeof commandPayloadSchema>;

// ── Result (agent → backend) ────────────────────────────────────────────────

export const resultKindSchema = z.enum(["accepted", "chunk", "result"]);

export const resultStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "timeout",
  "canceled",
  "rejected",
]);

export const resultErrorCodeSchema = z.enum([
  "agent_busy",
  "invalid_command",
  "expired",
  "unsupported_type",
  "spawn_failed",
  "run_as_failed",
  "timeout",
  "internal",
]);

export const resultPayloadSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  device_id: z.string().min(1),
  kind: resultKindSchema,
  status: resultStatusSchema.optional(),

  exit_code: z.number().int().nullable().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  truncated: z.boolean().optional(),
  dropped_bytes: z.number().int().nonnegative().optional(),

  started_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
  duration_ms: z.number().int().nonnegative().nullable().optional(),

  agent_version: z.string().optional(),
  error_code: resultErrorCodeSchema.nullable().optional(),
  error: z.string().nullable().optional(),

  // chunk-only fields
  seq: z.number().int().nonnegative().optional(),
  stream: z.enum(["stdout", "stderr"]).optional(),
  data: z.string().optional(),
  eof: z.boolean().optional(),
});

export type ResultPayload = z.infer<typeof resultPayloadSchema>;

// ── Status (agent → backend, retained) ──────────────────────────────────────

export const osInfoSchema = z.object({
  distro: z.string().optional(),
  version: z.string().optional(),
  kernel: z.string().optional(),
  arch: z.string().optional(),
  pretty: z.string().optional(),
  hostname: z.string().optional(),
});

export type OsInfo = z.infer<typeof osInfoSchema>;

export const metricsSchema = z.object({
  cpu_percent: z.number().default(0),
  mem_total_kb: z.number().default(0),
  mem_used_kb: z.number().default(0),
  mem_percent: z.number().default(0),
  disk_total_kb: z.number().default(0),
  disk_used_kb: z.number().default(0),
  disk_percent: z.number().default(0),
  load1: z.number().default(0),
  load5: z.number().default(0),
  load15: z.number().default(0),
  uptime_sec: z.number().default(0),
  processes: z.number().default(0),
});

export type Metrics = z.infer<typeof metricsSchema>;

export const statusPayloadSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  state: z.enum(["online", "offline"]),
  device_id: z.string().min(1),
  agent_version: z.string().optional(),
  /** New per connection attempt; fences stale Last-Will messages. */
  session_id: z.string().optional(),
  boot_id: z.string().optional(),
  reason: z.string().optional(),
  started_at: z.string().optional(),
  ts: z.string().optional(),
  os: osInfoSchema.optional(),
  metrics: metricsSchema.optional(),
});

export type StatusPayload = z.infer<typeof statusPayloadSchema>;

// ── Browser-facing SSE events ───────────────────────────────────────────────

export type SseEvent =
  | {
      type: "command.accepted";
      commandId: string;
      deviceId: string;
      /** "queued" while waiting for a worker slot, then "running". */
      status: "queued" | "running";
    }
  | {
      type: "command.chunk";
      commandId: string;
      deviceId: string;
      stream: "stdout" | "stderr";
      seq: number;
      data: string;
    }
  | {
      type: "command.result";
      commandId: string;
      deviceId: string;
      status: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      truncated: boolean;
      durationMs: number | null;
      error: string | null;
    }
  | {
      type: "device.status";
      deviceId: string;
      status: "ONLINE" | "OFFLINE";
      lastSeenAt: string | null;
    }
  | {
      type: "device.metrics";
      deviceId: string;
      cpuPercent: number;
      memPercent: number;
      diskPercent: number;
      load1: number;
      uptimeSec: number;
      processes: number;
      recordedAt: string;
    }
  | { type: "ping"; ts: string };
