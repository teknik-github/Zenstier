import { requirePermissionPage } from "@/server/modules/teams/context";
import { prisma } from "@/server/infrastructure/db/prisma";
import { TeamSettings } from "@/components/teams/team-settings";

export default async function TeamSettingsPage() {
  const ctx = await requirePermissionPage("team:read");

  const [deviceCount, memberCount] = await Promise.all([
    prisma.device.count({ where: { teamId: ctx.team.id } }),
    prisma.teamMember.count({ where: { teamId: ctx.team.id } }),
  ]);

  return (
    <div className="flex flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <p className="text-sm text-muted-foreground">
        Settings for {ctx.team.name}.
      </p>
      <TeamSettings
        team={ctx.team}
        deviceCount={deviceCount}
        memberCount={memberCount}
        canManageSettings={ctx.can("team:manage_settings")}
      />
    </div>
  );
}
