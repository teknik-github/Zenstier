-- CreateTable
CREATE TABLE "device_metrics_hourly" (
    "id" BIGSERIAL NOT NULL,
    "device_id" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "samples" INTEGER NOT NULL DEFAULT 0,
    "cpu_avg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cpu_max" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mem_avg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mem_max" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "disk_avg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "disk_max" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "load1_avg" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "device_metrics_hourly_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_metrics_hourly_bucket_idx" ON "device_metrics_hourly"("bucket");

-- CreateIndex
CREATE UNIQUE INDEX "device_metrics_hourly_device_id_bucket_key" ON "device_metrics_hourly"("device_id", "bucket");

-- AddForeignKey
ALTER TABLE "device_metrics_hourly" ADD CONSTRAINT "device_metrics_hourly_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
