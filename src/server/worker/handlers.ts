import { Prisma } from "@/generated/prisma/client";
import { CommandStatus, DeviceStatus, OutputStream } from "@/generated/prisma/enums";
import { prisma } from "@/server/infrastructure/db/prisma";
import { logger } from "@/server/infrastructure/logger/logger";
import { publish, deviceChannel } from "@/server/infrastructure/events/bus";
import {
  PROTOCOL_VERSION,
  resultPayloadSchema,
  statusPayloadSchema,
  topics,
  type ResultPayload,
  type StatusPayload,
} from "@/lib/protocol";

const log = logger.child({ module: "worker" });

/**
 * Presence is fenced by session id.
 *
 * An agent whose TCP connection dies may reconnect and publish `online` before
 * the broker notices the old session is dead (up to 1.5x keepalive later) and
 * fires its retained LWT. Without this fence that late `offline` would
 * overwrite a perfectly healthy device's state.
 */
export async function handleStatus(deviceId: string, raw: Buffer) {
  // A zero-length retained message is a tombstone from device deletion.
  if (raw.length === 0) return;

  let payload: StatusPayload;
  try {
    payload = statusPayloadSchema.parse(JSON.parse(raw.toString()));
  } catch (err) {
    log.warn("invalid status payload", { deviceId, error: String(err) });
    return;
  }

  const device = await prisma.device.findUnique({
    where: { deviceId },
    select: { id: true, currentSessionId: true, groupId: true },
  });
  if (!device) {
    log.warn("status for unknown device", { deviceId });
    return;
  }

  const sessionId = payload.session_id ?? null;

  if (payload.state === "online") {
    await prisma.device.update({
      where: { deviceId },
      data: {
        status: DeviceStatus.ONLINE,
        lastSeenAt: new Date(),
        currentSessionId: sessionId,
        hostname: payload.os?.hostname ?? undefined,
        osName: payload.os?.distro ?? undefined,
        osVersion: payload.os?.version ?? undefined,
        kernel: payload.os?.kernel ?? undefined,
        arch: payload.os?.arch ?? undefined,
        agentVersion: payload.agent_version ?? undefined,
      },
    });
  } else {
    // Drop a will belonging to a session that has already been superseded.
    if (
      sessionId &&
      device.currentSessionId &&
      sessionId !== device.currentSessionId
    ) {
      log.info("ignoring stale LWT from superseded session", {
        deviceId,
        sessionId,
      });
      return;
    }
    await prisma.device.update({
      where: { deviceId },
      data: { status: DeviceStatus.OFFLINE, lastSeenAt: new Date() },
    });
  }

  await publish(deviceChannel(deviceId), {
    type: "device.status",
    deviceId,
    status: payload.state === "online" ? "ONLINE" : "OFFLINE",
    lastSeenAt: new Date().toISOString(),
  });

  // Re-assert broadcast group membership on every connect.
  //
  // Changing a device's group makes the broker kick it (dynsec drops clients
  // it modifies), so an update_groups published at that moment is lost — the
  // session is clean, nothing queues. Pushing on connect makes the agent's
  // subscriptions converge on the database no matter how it got out of step.
  if (payload.state === "online") {
    await pushGroups(deviceId, device.groupId ? [device.groupId] : []);
  }

  // Heartbeats carry a resource sample; persist and fan it out.
  if (payload.state === "online" && payload.metrics) {
    const m = payload.metrics;
    const recordedAt = new Date();
    await prisma.deviceMetric.create({
      data: {
        deviceId: device.id,
        cpuPercent: m.cpu_percent,
        memPercent: m.mem_percent,
        memTotalKb: BigInt(Math.round(m.mem_total_kb)),
        memUsedKb: BigInt(Math.round(m.mem_used_kb)),
        diskPercent: m.disk_percent,
        diskTotalKb: BigInt(Math.round(m.disk_total_kb)),
        diskUsedKb: BigInt(Math.round(m.disk_used_kb)),
        load1: m.load1,
        load5: m.load5,
        load15: m.load15,
        uptimeSec: BigInt(Math.round(m.uptime_sec)),
        processes: m.processes,
        recordedAt,
      },
    });

    await publish(deviceChannel(deviceId), {
      type: "device.metrics",
      deviceId,
      cpuPercent: m.cpu_percent,
      memPercent: m.mem_percent,
      diskPercent: m.disk_percent,
      load1: m.load1,
      uptimeSec: m.uptime_sec,
      processes: m.processes,
      recordedAt: recordedAt.toISOString(),
    });
  }
}

async function pushGroups(deviceId: string, groups: string[]) {
  try {
    const { publishCommand } = await import(
      "@/server/infrastructure/mqtt/publisher"
    );
    const { randomUUID } = await import("node:crypto");
    await publishCommand(topics.command(deviceId), {
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      type: "update_groups",
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      groups,
    });
  } catch (err) {
    log.warn("could not push group membership", {
      deviceId,
      error: String(err),
    });
  }
}

const STREAM_MAP = {
  stdout: OutputStream.STDOUT,
  stderr: OutputStream.STDERR,
} as const;

export async function handleResult(deviceId: string, raw: Buffer) {
  let payload: ResultPayload;
  try {
    payload = resultPayloadSchema.parse(JSON.parse(raw.toString()));
  } catch (err) {
    log.warn("invalid result payload", { deviceId, error: String(err) });
    return;
  }

  const command = await prisma.command.findUnique({
    where: { id: payload.id },
    select: { id: true, deviceId: true, device: { select: { deviceId: true } } },
  });
  if (!command) {
    log.warn("result for unknown command", { commandId: payload.id, deviceId });
    return;
  }
  // A device may only report on its own commands.
  if (command.device.deviceId !== deviceId) {
    log.error("device reported a result for another device's command", {
      deviceId,
      commandId: payload.id,
    });
    return;
  }

  if (payload.kind === "accepted") {
    const running = payload.status !== "queued";
    if (running) {
      // Messages are handled concurrently and MQTT does not guarantee order,
      // so a late "running" must never clobber a terminal status.
      await prisma.command.updateMany({
        where: {
          id: payload.id,
          status: { in: [CommandStatus.PENDING, CommandStatus.DISPATCHED] },
        },
        data: { status: CommandStatus.RUNNING, startedAt: new Date() },
      });
    }
    await publish(deviceChannel(deviceId), {
      type: "command.accepted",
      commandId: payload.id,
      deviceId,
      status: running ? "running" : "queued",
    });
    return;
  }

  if (payload.kind === "chunk") {
    const seq = payload.seq ?? 0;
    const stream = STREAM_MAP[payload.stream ?? "stdout"];
    // QoS 1 is at-least-once, so writes must be idempotent. `upsert` still
    // races against a concurrent insert of the same key, so the unique
    // violation is treated as success rather than retried.
    try {
      await prisma.commandOutput.create({
        data: {
          commandId: payload.id,
          deviceId: command.deviceId,
          seq,
          stream,
          chunk: payload.data ?? "",
        },
      });
    } catch (err) {
      if (
        !(
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        )
      ) {
        throw err;
      }
    }
    await publish(deviceChannel(deviceId), {
      type: "command.chunk",
      commandId: payload.id,
      deviceId,
      stream: payload.stream ?? "stdout",
      seq,
      data: payload.data ?? "",
    });
    return;
  }

  // Terminal result.
  const status = mapStatus(payload.status);
  const finishedAt = payload.finished_at
    ? new Date(payload.finished_at)
    : new Date();

  await prisma.command.update({
    where: { id: payload.id },
    data: {
      status,
      exitCode: payload.exit_code ?? null,
      stdout: payload.stdout ?? null,
      stderr: payload.stderr ?? null,
      truncated: payload.truncated ?? false,
      error: payload.error ?? null,
      durationMs: payload.duration_ms ?? null,
      startedAt: payload.started_at ? new Date(payload.started_at) : undefined,
      finishedAt,
    },
  });

  await publish(deviceChannel(deviceId), {
    type: "command.result",
    commandId: payload.id,
    deviceId,
    status,
    exitCode: payload.exit_code ?? null,
    stdout: payload.stdout ?? "",
    stderr: payload.stderr ?? "",
    truncated: payload.truncated ?? false,
    durationMs: payload.duration_ms ?? null,
    error: payload.error ?? null,
  });
}

function mapStatus(status?: string): CommandStatus {
  switch (status) {
    case "completed":
      return CommandStatus.SUCCEEDED;
    case "failed":
    case "rejected":
      return CommandStatus.FAILED;
    case "timeout":
      return CommandStatus.TIMEOUT;
    case "canceled":
      return CommandStatus.CANCELED;
    case "running":
      return CommandStatus.RUNNING;
    default:
      return CommandStatus.SUCCEEDED;
  }
}
