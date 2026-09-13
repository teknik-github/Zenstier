import { requirePermissionPage } from "@/server/modules/teams/context";
import { prisma } from "@/server/infrastructure/db/prisma";
import { listGroups } from "@/server/modules/devices/group.service";
import { GroupManager, type GroupRow } from "@/components/devices/group-manager";

export default async function GroupsPage() {
  const ctx = await requirePermissionPage("device:read");

  const [groups, devices] = await Promise.all([
    listGroups(ctx.team.id),
    prisma.device.findMany({
      where: { teamId: ctx.team.id },
      orderBy: [{ name: "asc" }],
      select: {
        deviceId: true,
        name: true,
        status: true,
        groupId: true,
      },
    }),
  ]);

  const rows: GroupRow[] = groups.map((g) => ({
    id: g.id,
    name: g.name,
    devices: g.devices.map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      status: d.status,
    })),
  }));

  return (
    <div className="flex flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <p className="text-sm text-muted-foreground">
        Groups let one publish reach many devices. Each agent derives its own
        command id from the batch, so every run is still audited per device.
      </p>
      <GroupManager
        groups={rows}
        devices={devices}
        canEdit={ctx.can("device:update")}
      />
    </div>
  );
}
