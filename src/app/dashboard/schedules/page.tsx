import { requirePermissionPage } from "@/server/modules/teams/context";
import { prisma } from "@/server/infrastructure/db/prisma";
import { listSchedules } from "@/server/modules/schedules/schedule.service";
import { listGroups } from "@/server/modules/devices/group.service";
import {
  ScheduleManager,
  type ScheduleRow,
} from "@/components/schedules/schedule-manager";

export default async function SchedulesPage() {
  const ctx = await requirePermissionPage("command:read");

  const [schedules, devices, groups] = await Promise.all([
    listSchedules(ctx.team.id),
    prisma.device.findMany({
      where: { teamId: ctx.team.id },
      orderBy: { name: "asc" },
      select: { deviceId: true, name: true },
    }),
    listGroups(ctx.team.id),
  ]);

  const byId = new Map(devices.map((d) => [d.deviceId, d.name]));

  const rows: ScheduleRow[] = schedules.map((s) => ({
    id: s.id,
    name: s.name,
    command: s.command,
    cron: s.cron,
    status: s.status,
    groupName: s.group?.name ?? null,
    deviceNames: s.deviceIds.map((d) => byId.get(d) ?? d),
    lastRunAt: s.lastRunAt?.toISOString() ?? null,
    lastStatus: s.lastStatus,
    nextRunAt: s.nextRunAt?.toISOString() ?? null,
    runCount: s.runCount,
    owner: s.user.name ?? s.user.email,
  }));

  return (
    <div className="flex flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <p className="text-sm text-muted-foreground">
        Recurring commands, evaluated in UTC. A missed window is not replayed:
        if the worker was down for six hours, a five-minute job runs once on
        recovery rather than seventy-two times.
      </p>
      <ScheduleManager
        schedules={rows}
        devices={devices}
        groups={groups.map((g) => ({
          id: g.id,
          name: g.name,
          deviceCount: g.devices.length,
        }))}
        canManage={ctx.can("command:execute")}
      />
    </div>
  );
}
