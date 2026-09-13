import "server-only";
import { prisma } from "@/server/infrastructure/db/prisma";
import { wrapDeviceOutput } from "./prompts";

/**
 * Builds the factual context the assistant reasons over.
 *
 * Only ever data the caller's own team owns, so the assistant cannot be talked
 * into describing another tenant's fleet.
 */
export async function buildFleetContext(
  teamId: string,
  selectedDeviceIds: string[],
): Promise<string> {
  const devices = await prisma.device.findMany({
    where: {
      teamId,
      ...(selectedDeviceIds.length
        ? { deviceId: { in: selectedDeviceIds } }
        : {}),
    },
    orderBy: [{ status: "asc" }, { name: "asc" }],
    take: 100,
    include: {
      group: { select: { name: true } },
      metrics: { orderBy: { recordedAt: "desc" }, take: 1 },
    },
  });

  if (devices.length === 0) {
    return "No devices are currently in scope.";
  }

  const lines = devices.map((d) => {
    const m = d.metrics[0];
    const os = [d.osName, d.osVersion].filter(Boolean).join(" ") || "unknown OS";
    const facts = [
      `- ${d.name} (${d.deviceId})`,
      `status=${d.status}`,
      `os=${os}`,
      d.kernel ? `kernel=${d.kernel}` : null,
      d.arch ? `arch=${d.arch}` : null,
      d.group ? `group=${d.group.name}` : null,
      m ? `cpu=${m.cpuPercent.toFixed(0)}%` : null,
      m ? `mem=${m.memPercent.toFixed(0)}%` : null,
      m ? `disk=${m.diskPercent.toFixed(0)}%` : null,
      m ? `load1=${m.load1}` : null,
      m ? `uptime=${Math.floor(Number(m.uptimeSec) / 3600)}h` : null,
    ]
      .filter(Boolean)
      .join(" ");
    return facts;
  });

  return [
    `Devices in scope (${devices.length}):`,
    ...lines,
    "",
    "Commands you propose will run on the devices the operator has selected.",
  ].join("\n");
}

/**
 * Recent command history, including output.
 *
 * Output is wrapped as untrusted data: it comes from managed machines and must
 * never be read as instructions.
 */
export async function buildHistoryContext(
  teamId: string,
  selectedDeviceIds: string[],
  limit = 6,
): Promise<string> {
  const commands = await prisma.command.findMany({
    where: {
      teamId,
      ...(selectedDeviceIds.length
        ? { device: { deviceId: { in: selectedDeviceIds } } }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { device: { select: { name: true } } },
  });

  if (commands.length === 0) return "";

  const blocks = commands.reverse().map((c) => {
    const header = `$ ${c.command}   [${c.device.name} · ${c.status}${
      c.exitCode !== null ? ` · exit ${c.exitCode}` : ""
    }]`;
    const body = [c.stdout, c.stderr].filter(Boolean).join("\n").trim();
    return body
      ? `${header}\n${wrapDeviceOutput(c.device.name, body)}`
      : header;
  });

  return ["Recent commands on these devices:", ...blocks].join("\n\n");
}
