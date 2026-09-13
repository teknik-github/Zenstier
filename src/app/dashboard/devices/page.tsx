import { headers } from "next/headers";
import { requirePermissionPage } from "@/server/modules/teams/context";
import { prisma } from "@/server/infrastructure/db/prisma";
import { DeviceManager, type DeviceRow } from "@/components/devices/device-manager";

export default async function DevicesPage() {
  const ctx = await requirePermissionPage("device:read");

  const devices = await prisma.device.findMany({
    where: { teamId: ctx.team.id },
    orderBy: [{ createdAt: "desc" }],
    include: { tokens: { select: { status: true } } },
  });

  // `headers()` is async in Next 16.
  const headerList = await headers();
  const host = headerList.get("host") ?? "localhost:3020";
  const proto = headerList.get("x-forwarded-proto") ?? "http";
  const serverUrl = `${proto}://${host}`;

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
    enrolled: d.tokens.some((t) => t.status === "CONSUMED"),
  }));

  return (
    <div className="flex flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <p className="text-sm text-muted-foreground">
        Each device gets its own credentials. Revoking disconnects it
        immediately.
      </p>
      <DeviceManager
        devices={rows}
        serverUrl={serverUrl}
        canCreate={ctx.can("device:create")}
        canRevoke={ctx.can("device:revoke")}
        canDelete={ctx.can("device:delete")}
      />
    </div>
  );
}
