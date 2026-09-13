import { requirePermissionPage } from "@/server/modules/teams/context";
import { prisma } from "@/server/infrastructure/db/prisma";
import { CommandConsole } from "@/components/console/command-console";
import { listGroups } from "@/server/modules/devices/group.service";
import type { DeviceRow } from "@/components/devices/device-manager";

export default async function ConsolePage() {
  const ctx = await requirePermissionPage("command:read");

  const [devices, groups] = await Promise.all([
    prisma.device.findMany({
      where: { teamId: ctx.team.id },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    }),
    listGroups(ctx.team.id),
  ]);

  const rows: DeviceRow[] = devices.map((d) => ({
    deviceId: d.deviceId,
    name: d.name,
    status: d.status,
    lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
    hostname: d.hostname,
    osName: d.osName,
    osVersion: d.osVersion,
    kernel: d.kernel,
    arch: d.arch,
    agentVersion: d.agentVersion,
    enrolled: true,
    groupId: d.groupId,
  }));

  return (
    <CommandConsole
      devices={rows}
      groups={groups.map((g) => ({
        id: g.id,
        name: g.name,
        deviceCount: g.devices.length,
      }))}
      canExecute={ctx.can("command:execute")}
    />
  );
}
