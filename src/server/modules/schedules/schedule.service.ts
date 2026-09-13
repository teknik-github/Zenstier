import "server-only";
import { CronExpressionParser } from "cron-parser";
import { AuditAction, ScheduleStatus } from "@/generated/prisma/enums";
import { prisma } from "@/server/infrastructure/db/prisma";
import { logger } from "@/server/infrastructure/logger/logger";

const log = logger.child({ module: "schedules" });

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

/**
 * Schedules are evaluated in UTC.
 *
 * Local time would mean a daily job silently running twice, or not at all, on
 * the two days a year the clocks change — which for a job that restarts
 * services is not a theoretical problem.
 */
const CRON_TZ = "UTC";

export function nextRun(cron: string, after: Date = new Date()): Date {
  try {
    return CronExpressionParser.parse(cron, {
      tz: CRON_TZ,
      currentDate: after,
    })
      .next()
      .toDate();
  } catch (err) {
    throw new ScheduleError(`Invalid cron expression: ${(err as Error).message}`);
  }
}

export function describeCron(cron: string): string {
  try {
    const next = nextRun(cron);
    return `next ${next.toISOString().replace("T", " ").slice(0, 16)} UTC`;
  } catch {
    return "invalid";
  }
}

export function listSchedules(teamId: string) {
  return prisma.schedule.findMany({
    where: { teamId },
    orderBy: [{ status: "asc" }, { name: "asc" }],
    include: {
      group: { select: { id: true, name: true } },
      user: { select: { name: true, email: true } },
    },
  });
}

export interface ScheduleInput {
  name: string;
  command: string;
  cron: string;
  groupId?: string | null;
  deviceIds?: string[];
  timeoutMs?: number;
}

async function validateTargets(teamId: string, input: ScheduleInput) {
  if (input.groupId) {
    const group = await prisma.deviceGroup.findFirst({
      where: { id: input.groupId, teamId },
    });
    if (!group) throw new ScheduleError("Group not found");
    return;
  }
  if (!input.deviceIds?.length) {
    throw new ScheduleError("Pick at least one device, or a group");
  }
  const owned = await prisma.device.count({
    where: { teamId, deviceId: { in: input.deviceIds } },
  });
  if (owned !== input.deviceIds.length) {
    throw new ScheduleError("One or more devices are not in this team");
  }
}

export async function createSchedule(
  userId: string,
  teamId: string,
  input: ScheduleInput,
) {
  const name = input.name.trim();
  const command = input.command.trim();
  if (!name) throw new ScheduleError("Name is required");
  if (!command) throw new ScheduleError("Command is required");

  // Fail on a bad expression now, rather than silently never running.
  const next = nextRun(input.cron);
  await validateTargets(teamId, input);

  const schedule = await prisma.schedule.create({
    data: {
      teamId,
      userId,
      name,
      command,
      cron: input.cron.trim(),
      groupId: input.groupId ?? null,
      deviceIds: input.groupId ? [] : (input.deviceIds ?? []),
      timeoutMs: input.timeoutMs ?? 60_000,
      nextRunAt: next,
    },
  });

  await prisma.auditLog.create({
    data: {
      userId,
      teamId,
      action: AuditAction.SCHEDULE_CREATED,
      targetType: "schedule",
      targetId: schedule.id,
      metadata: { name, cron: input.cron, command },
    },
  });
  log.info("schedule created", { id: schedule.id, cron: input.cron });
  return schedule;
}

export async function setScheduleStatus(
  userId: string,
  teamId: string,
  scheduleId: string,
  status: ScheduleStatus,
) {
  const schedule = await prisma.schedule.findFirst({
    where: { id: scheduleId, teamId },
  });
  if (!schedule) throw new ScheduleError("Schedule not found");

  const updated = await prisma.schedule.update({
    where: { id: scheduleId },
    data: {
      status,
      // Resuming from a pause must not fire immediately for every missed slot.
      nextRunAt:
        status === ScheduleStatus.ACTIVE ? nextRun(schedule.cron) : null,
    },
  });

  await prisma.auditLog.create({
    data: {
      userId,
      teamId,
      action: AuditAction.SCHEDULE_UPDATED,
      targetType: "schedule",
      targetId: scheduleId,
      metadata: { name: schedule.name, status },
    },
  });
  return updated;
}

export async function deleteSchedule(
  userId: string,
  teamId: string,
  scheduleId: string,
) {
  const schedule = await prisma.schedule.findFirst({
    where: { id: scheduleId, teamId },
  });
  if (!schedule) throw new ScheduleError("Schedule not found");

  await prisma.schedule.delete({ where: { id: scheduleId } });
  await prisma.auditLog.create({
    data: {
      userId,
      teamId,
      action: AuditAction.SCHEDULE_DELETED,
      targetType: "schedule",
      targetId: scheduleId,
      metadata: { name: schedule.name },
    },
  });
}

/**
 * Claims and runs every schedule that is due.
 *
 * `nextRunAt` is advanced inside a conditional update, so two workers racing
 * can never both dispatch the same occurrence: the loser's update matches zero
 * rows and it skips.
 *
 * A missed window is not replayed. If the worker was down for six hours, a
 * five-minute job runs once on recovery rather than seventy-two times — which
 * for a command that restarts services is the only safe reading.
 */
export async function runDueSchedules(now: Date = new Date()): Promise<number> {
  const due = await prisma.schedule.findMany({
    where: {
      status: ScheduleStatus.ACTIVE,
      nextRunAt: { lte: now },
    },
    take: 50,
  });

  let dispatched = 0;

  for (const schedule of due) {
    const claimed = await prisma.schedule.updateMany({
      where: { id: schedule.id, nextRunAt: schedule.nextRunAt },
      data: { nextRunAt: nextRun(schedule.cron, now) },
    });
    if (claimed.count === 0) continue; // another worker took it

    try {
      const { dispatchCommand } = await import(
        "@/server/modules/commands/command.service"
      );
      const result = await dispatchCommand(schedule.userId, schedule.teamId, {
        command: schedule.command,
        deviceIds: schedule.groupId ? [] : schedule.deviceIds,
        groupId: schedule.groupId,
        timeoutMs: schedule.timeoutMs,
        useBroadcastTopic: false,
      });

      await prisma.schedule.update({
        where: { id: schedule.id },
        data: {
          lastRunAt: now,
          lastStatus: `dispatched to ${result.dispatched.length} device(s)`,
          runCount: { increment: 1 },
        },
      });
      await prisma.auditLog.create({
        data: {
          userId: schedule.userId,
          teamId: schedule.teamId,
          action: AuditAction.SCHEDULE_RAN,
          targetType: "schedule",
          targetId: schedule.id,
          metadata: {
            name: schedule.name,
            devices: result.dispatched.length,
            skipped: result.skipped.length,
          },
        },
      });
      dispatched += 1;
      log.info("schedule ran", {
        id: schedule.id,
        name: schedule.name,
        devices: result.dispatched.length,
      });
    } catch (err) {
      // A schedule whose devices are all offline is a normal outcome, not a
      // reason to stop scheduling it.
      await prisma.schedule.update({
        where: { id: schedule.id },
        data: {
          lastRunAt: now,
          lastStatus: `failed: ${(err as Error).message}`.slice(0, 200),
        },
      });
      log.warn("schedule failed", {
        id: schedule.id,
        error: String(err),
      });
    }
  }

  return dispatched;
}
