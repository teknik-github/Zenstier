-- CreateEnum
CREATE TYPE "AlertMetric" AS ENUM ('CPU', 'MEMORY', 'DISK', 'OFFLINE');

-- CreateEnum
CREATE TYPE "AlertState" AS ENUM ('OK', 'FIRING');

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metric" "AlertMetric" NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL DEFAULT 90,
    "for_minutes" INTEGER NOT NULL DEFAULT 5,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "webhook_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rule_states" (
    "id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "state" "AlertState" NOT NULL DEFAULT 'OK',
    "since" TIMESTAMP(3),
    "last_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fired_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "alert_rule_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_rules_team_id_idx" ON "alert_rules"("team_id");

-- CreateIndex
CREATE INDEX "alert_rule_states_state_idx" ON "alert_rule_states"("state");

-- CreateIndex
CREATE UNIQUE INDEX "alert_rule_states_rule_id_device_id_key" ON "alert_rule_states"("rule_id", "device_id");

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rule_states" ADD CONSTRAINT "alert_rule_states_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rule_states" ADD CONSTRAINT "alert_rule_states_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
