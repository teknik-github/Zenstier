import { requirePermissionPage } from "@/server/modules/teams/context";
import { prisma } from "@/server/infrastructure/db/prisma";
import { isAiConfigured } from "@/server/config/env";
import { AiConsole } from "@/components/ai/ai-console";
import type { DeviceRow } from "@/components/devices/device-manager";

export default async function AiPage() {
  const ctx = await requirePermissionPage("ai:use");

  const devices = await prisma.device.findMany({
    where: { teamId: ctx.team.id },
    orderBy: [{ status: "asc" }, { name: "asc" }],
  });

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
  }));

  return (
    <div className="flex flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <p className="text-sm text-muted-foreground">
        The assistant drafts commands and reads output. It cannot execute
        anything — every command still goes through your own permissions, rate
        limit and audit log.
      </p>
      <AiConsole
        devices={rows}
        canExecute={ctx.can("command:execute")}
        configured={isAiConfigured}
      />
    </div>
  );
}
