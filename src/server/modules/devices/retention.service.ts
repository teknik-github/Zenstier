import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/infrastructure/db/prisma";
import { env } from "@/server/config/env";
import { logger } from "@/server/infrastructure/logger/logger";

const log = logger.child({ module: "retention" });

export interface RetentionResult {
  bucketsWritten: number;
  rawDeleted: number;
  hourlyDeleted: number;
}

/**
 * Rolls raw metric samples into hourly buckets, then prunes.
 *
 * Agents heartbeat every 30s, so raw rows accumulate at ~120/hour/device —
 * about 92 million rows a year across 100 devices. Left alone the table grows
 * without bound and the dashboard's range queries degrade with it. Rolling up
 * first means long-range history survives at roughly 1/120th the size.
 *
 * The aggregation is done in SQL rather than in application code so a large
 * backlog never has to be pulled into memory.
 */
export async function runMetricRetention(): Promise<RetentionResult> {
  const rawCutoff = new Date(
    Date.now() - env.METRICS_RAW_RETENTION_HOURS * 60 * 60 * 1000,
  );
  const hourlyCutoff = new Date(
    Date.now() - env.METRICS_HOURLY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

  // Roll up every bucket that is complete (strictly before the current hour),
  // upserting so a re-run is harmless and a partially-filled bucket is fixed
  // up on the next pass.
  const bucketsWritten = await prisma.$executeRaw`
    INSERT INTO device_metrics_hourly
      (device_id, bucket, samples, cpu_avg, cpu_max, mem_avg, mem_max,
       disk_avg, disk_max, load1_avg)
    SELECT
      device_id,
      date_trunc('hour', recorded_at) AS bucket,
      count(*),
      avg(cpu_percent),  max(cpu_percent),
      avg(mem_percent),  max(mem_percent),
      avg(disk_percent), max(disk_percent),
      avg(load1)
    FROM device_metrics
    WHERE recorded_at < date_trunc('hour', now())
    GROUP BY device_id, date_trunc('hour', recorded_at)
    ON CONFLICT (device_id, bucket) DO UPDATE SET
      samples   = EXCLUDED.samples,
      cpu_avg   = EXCLUDED.cpu_avg,
      cpu_max   = EXCLUDED.cpu_max,
      mem_avg   = EXCLUDED.mem_avg,
      mem_max   = EXCLUDED.mem_max,
      disk_avg  = EXCLUDED.disk_avg,
      disk_max  = EXCLUDED.disk_max,
      load1_avg = EXCLUDED.load1_avg
  `;

  // Only prune raw rows whose bucket has actually been written, so a failed
  // roll-up can never silently destroy data.
  const rawDeleted = await prisma.$executeRaw`
    DELETE FROM device_metrics dm
    WHERE dm.recorded_at < ${rawCutoff}
      AND EXISTS (
        SELECT 1 FROM device_metrics_hourly h
        WHERE h.device_id = dm.device_id
          AND h.bucket = date_trunc('hour', dm.recorded_at)
      )
  `;

  const hourlyDeleted = await prisma.deviceMetricHourly.deleteMany({
    where: { bucket: { lt: hourlyCutoff } },
  });

  const result = {
    bucketsWritten,
    rawDeleted,
    hourlyDeleted: hourlyDeleted.count,
  };

  if (rawDeleted > 0 || hourlyDeleted.count > 0) {
    log.info("metric retention ran", result);
  }
  return result;
}

/** Row counts and on-disk size, for the admin view. */
export async function metricStorageStats() {
  const rows = await prisma.$queryRaw<
    { raw: bigint; hourly: bigint; raw_bytes: bigint; hourly_bytes: bigint }[]
  >(Prisma.sql`
    SELECT
      (SELECT count(*) FROM device_metrics)            AS raw,
      (SELECT count(*) FROM device_metrics_hourly)     AS hourly,
      pg_total_relation_size('device_metrics')         AS raw_bytes,
      pg_total_relation_size('device_metrics_hourly')  AS hourly_bytes
  `);
  const r = rows[0];
  return {
    rawRows: Number(r?.raw ?? 0),
    hourlyRows: Number(r?.hourly ?? 0),
    rawBytes: Number(r?.raw_bytes ?? 0),
    hourlyBytes: Number(r?.hourly_bytes ?? 0),
  };
}
