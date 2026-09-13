import "server-only";
import { v5 as uuidv5 } from "uuid";
import { randomUUID } from "node:crypto";
import { AuditAction, CommandStatus, DeviceStatus } from "@/generated/prisma/enums";
import { prisma } from "@/server/infrastructure/db/prisma";
import { logger } from "@/server/infrastructure/logger/logger";
import { publishCommand } from "@/server/infrastructure/mqtt/publisher";
import { checkCommandRateLimit } from "@/server/infrastructure/ratelimit/ratelimit";
import { PROTOCOL_VERSION, topics } from "@/lib/protocol";
import type { DispatchCommandInput } from "./command.schema";

const log = logger.child({ module: "commands" });

/** Fixed namespace so command ids are reproducible across processes. */
const ZENSTIER_NAMESPACE = "8b1d6a6e-4a1f-4c7e-9d2b-6f0e5a3c1b74";

/**
 * Deterministic per-device command id.
 *
 * For a broadcast the payload carries only the batch id, and each agent derives
 * its own command id from (batchId, its own device id). The server pre-inserted
 * rows with exactly those ids, so no per-device lookup table has to travel on
 * the wire. Re-publishing a stuck command also yields the same id, folding a
 * duplicate execution into the same history row.
 */
export function commandIdFor(batchId: string, deviceId: string): string {
  return uuidv5(`${batchId}:${deviceId}`, ZENSTIER_NAMESPACE);
}

export interface DispatchOutcome {
  batchId: string;
  dispatched: { deviceId: string; commandId: string }[];
  skipped: { deviceId: string; reason: string }[];
}

export async function dispatchCommand(
  userId: string,
  teamId: string,
  input: DispatchCommandInput,
): Promise<DispatchOutcome> {
  // Targets are always resolved within the caller's team, so a device id from
  // another team simply does not match.
  const targets = await prisma.device.findMany({
    where: {
      teamId,
      ...(input.groupId && input.deviceIds.length === 0
        ? { groupId: input.groupId }
        : { deviceId: { in: input.deviceIds } }),
    },
    select: { id: true, deviceId: true, status: true, name: true },
  });

  if (targets.length === 0) {
    throw new Error("No matching devices in this team");
  }

  const skipped: { deviceId: string; reason: string }[] = [];
  const online = targets.filter((t) => {
    if (t.status !== DeviceStatus.ONLINE) {
      skipped.push({ deviceId: t.deviceId, reason: "offline" });
      return false;
    }
    return true;
  });

  if (online.length === 0) {
    throw new Error("All selected devices are offline");
  }

  // Rate limit before writing anything.
  const limit = await checkCommandRateLimit(
    userId,
    online.map((d) => d.deviceId),
  );
  if (limit.userRetryAfterMs > 0) {
    await prisma.auditLog.create({
      data: {
        userId,
        teamId,
        action: AuditAction.COMMAND_RATE_LIMITED,
        targetType: "user",
        targetId: userId,
        metadata: { retryAfterMs: limit.userRetryAfterMs },
      },
    });
    throw new Error(
      `Rate limit reached. Try again in ${Math.ceil(limit.userRetryAfterMs / 1000)}s`,
    );
  }
  for (const l of limit.limited) {
    skipped.push({
      deviceId: l.deviceId,
      reason: `rate limited (${Math.ceil(l.retryAfterMs / 1000)}s)`,
    });
  }

  const allowedSet = new Set(limit.allowed);
  const finalTargets = online.filter((d) => allowedSet.has(d.deviceId));
  if (finalTargets.length === 0) {
    throw new Error("All selected devices are rate limited");
  }

  const batchId = randomUUID();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + input.timeoutMs + 30_000);

  // Rows must exist BEFORE publishing: a fast agent can return a result
  // before the insert lands, and the output FK would then fail silently.
  await prisma.$transaction([
    prisma.commandBatch.create({
      data: {
        id: batchId,
        userId,
        teamId,
        command: input.command,
        groupId: input.groupId ?? null,
      },
    }),
    prisma.command.createMany({
      data: finalTargets.map((t) => ({
        id: commandIdFor(batchId, t.deviceId),
        correlationId: commandIdFor(batchId, t.deviceId),
        userId,
        teamId,
        deviceId: t.id,
        batchId,
        command: input.command,
        status: CommandStatus.PENDING,
        timeoutMs: input.timeoutMs,
      })),
    }),
    prisma.auditLog.create({
      data: {
        userId,
        teamId,
        action: AuditAction.COMMAND_DISPATCHED,
        targetType: "batch",
        targetId: batchId,
        metadata: {
          command: input.command,
          deviceIds: finalTargets.map((t) => t.deviceId),
        },
      },
    }),
  ]);

  const dispatched: { deviceId: string; commandId: string }[] = [];

  if (input.useBroadcastTopic && input.groupId) {
    // One publish reaches the whole group; each agent derives its own id.
    await publishCommand(topics.broadcastCommand(input.groupId), {
      v: PROTOCOL_VERSION,
      batch_id: batchId,
      type: "exec",
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      issued_by: userId,
      command: input.command,
      timeout_sec: Math.ceil(input.timeoutMs / 1000),
    });
    for (const t of finalTargets) {
      dispatched.push({
        deviceId: t.deviceId,
        commandId: commandIdFor(batchId, t.deviceId),
      });
    }
  } else {
    // Per-device fan-out: one publish each, giving per-device delivery control.
    await Promise.all(
      finalTargets.map(async (t) => {
        const commandId = commandIdFor(batchId, t.deviceId);
        await publishCommand(topics.command(t.deviceId), {
          v: PROTOCOL_VERSION,
          id: commandId,
          batch_id: batchId,
          type: "exec",
          issued_at: issuedAt.toISOString(),
          expires_at: expiresAt.toISOString(),
          issued_by: userId,
          command: input.command,
          timeout_sec: Math.ceil(input.timeoutMs / 1000),
          stream: true,
        });
        dispatched.push({ deviceId: t.deviceId, commandId });
      }),
    );
  }

  await prisma.command.updateMany({
    where: { batchId },
    data: { status: CommandStatus.DISPATCHED, dispatchedAt: new Date() },
  });

  log.info("command dispatched", {
    batchId,
    targets: dispatched.length,
    skipped: skipped.length,
  });

  return { batchId, dispatched, skipped };
}

export function listCommandHistory(
  teamId: string,
  deviceId?: string,
  limit = 50,
) {
  return prisma.command.findMany({
    where: {
      teamId,
      ...(deviceId ? { device: { deviceId } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { device: { select: { name: true, deviceId: true } } },
  });
}
