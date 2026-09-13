-- CreateTable
CREATE TABLE "device_metrics" (
    "id" BIGSERIAL NOT NULL,
    "device_id" TEXT NOT NULL,
    "cpu_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mem_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mem_total_kb" BIGINT NOT NULL DEFAULT 0,
    "mem_used_kb" BIGINT NOT NULL DEFAULT 0,
    "disk_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "disk_total_kb" BIGINT NOT NULL DEFAULT 0,
    "disk_used_kb" BIGINT NOT NULL DEFAULT 0,
    "load1" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "load5" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "load15" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "uptime_sec" BIGINT NOT NULL DEFAULT 0,
    "processes" INTEGER NOT NULL DEFAULT 0,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_metrics_device_id_recorded_at_idx" ON "device_metrics"("device_id", "recorded_at");

-- AddForeignKey
ALTER TABLE "device_metrics" ADD CONSTRAINT "device_metrics_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
