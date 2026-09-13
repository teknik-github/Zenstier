import { requirePermissionPage } from "@/server/modules/teams/context";
import { prisma } from "@/server/infrastructure/db/prisma";
import { SectionCards, type FleetSummary } from "@/components/section-cards";
import {
  ChartAreaInteractive,
  type MetricPoint,
} from "@/components/chart-area-interactive";
import { DataTable } from "@/components/data-table";
import type { DeviceRow } from "@/components/devices/device-manager";
import { hoursAgo, startOfToday } from "@/server/modules/commands/time-window";

export default async function OverviewPage() {
  const ctx = await requirePermissionPage("device:read");

  const since = hoursAgo(6);
  const startOfDay = startOfToday();

  const [devices, commandsToday, failuresToday, samples, latestSamples] =
    await Promise.all([
    prisma.device.findMany({
      where: { teamId: ctx.team.id },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    }),
    prisma.command.count({
      where: { teamId: ctx.team.id, createdAt: { gte: startOfDay } },
    }),
    prisma.command.count({
      where: {
        teamId: ctx.team.id,
        createdAt: { gte: startOfDay },
        status: { in: ["FAILED", "TIMEOUT"] },
      },
    }),
    prisma.deviceMetric.findMany({
      where: { device: { teamId: ctx.team.id }, recordedAt: { gte: since } },
      orderBy: { recordedAt: "asc" },
      select: {
        recordedAt: true,
        cpuPercent: true,
        memPercent: true,
        diskPercent: true,
      },
      take: 5000,
    }),
    prisma.deviceMetric.findMany({
      where: { device: { teamId: ctx.team.id } },
      orderBy: { recordedAt: "desc" },
      take: 200,
    }),
  ]);

  // Average across devices per 1-minute bucket so one chatty host cannot
  // dominate the fleet view.
  const buckets = new Map<
    number,
    { cpu: number; memory: number; disk: number; n: number }
  >();
  for (const s of samples) {
    const key = Math.floor(s.recordedAt.getTime() / 60_000) * 60_000;
    const b = buckets.get(key) ?? { cpu: 0, memory: 0, disk: 0, n: 0 };
    b.cpu += s.cpuPercent;
    b.memory += s.memPercent;
    b.disk += s.diskPercent;
    b.n += 1;
    buckets.set(key, b);
  }

  const chartData: MetricPoint[] = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ts, b]) => ({
      ts: new Date(ts).toISOString(),
      cpu: +(b.cpu / b.n).toFixed(2),
      memory: +(b.memory / b.n).toFixed(2),
      disk: +(b.disk / b.n).toFixed(2),
    }));

  const latest = chartData.at(-1);
  const summary: FleetSummary = {
    totalDevices: devices.length,
    onlineDevices: devices.filter((d) => d.status === "ONLINE").length,
    avgCpuPercent: latest?.cpu ?? 0,
    avgMemPercent: latest?.memory ?? 0,
    commandsToday,
    failuresToday,
  };

  // Latest stored sample per device, so the table is populated immediately.
  const latestByDevice = new Map<string, (typeof latestSamples)[number]>();
  for (const sample of latestSamples) {
    if (!latestByDevice.has(sample.deviceId)) {
      latestByDevice.set(sample.deviceId, sample);
    }
  }

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
    metrics: (() => {
      const m = latestByDevice.get(d.id);
      return m
        ? {
            cpuPercent: m.cpuPercent,
            memPercent: m.memPercent,
            diskPercent: m.diskPercent,
            load1: m.load1,
            uptimeSec: Number(m.uptimeSec),
            processes: m.processes,
            recordedAt: m.recordedAt.toISOString(),
          }
        : null;
    })(),
  }));

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <SectionCards summary={summary} />
      <div className="px-4 lg:px-6">
        <ChartAreaInteractive
          data={chartData}
          deviceIds={devices.map((d) => d.deviceId)}
        />
      </div>
      <DataTable data={rows} />
    </div>
  );
}
