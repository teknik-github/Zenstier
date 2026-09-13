-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'SCHEDULE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'SCHEDULE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'SCHEDULE_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'SCHEDULE_RAN';
ALTER TYPE "AuditAction" ADD VALUE 'ALERT_RULE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'ALERT_RULE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'ALERT_RULE_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'ALERT_FIRED';

-- CreateTable
CREATE TABLE "schedules" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
    "group_id" TEXT,
    "device_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timeout_ms" INTEGER NOT NULL DEFAULT 60000,
    "last_run_at" TIMESTAMP(3),
    "last_status" TEXT,
    "next_run_at" TIMESTAMP(3),
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schedules_team_id_idx" ON "schedules"("team_id");

-- CreateIndex
CREATE INDEX "schedules_status_next_run_at_idx" ON "schedules"("status", "next_run_at");

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "device_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
