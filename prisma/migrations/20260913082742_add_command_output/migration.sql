-- CreateEnum
CREATE TYPE "OutputStream" AS ENUM ('STDOUT', 'STDERR', 'SYSTEM');

-- CreateTable
CREATE TABLE "command_output" (
    "id" BIGSERIAL NOT NULL,
    "command_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "stream" "OutputStream" NOT NULL,
    "chunk" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "command_output_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "command_output_device_id_id_idx" ON "command_output"("device_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "command_output_command_id_seq_key" ON "command_output"("command_id", "seq");

-- AddForeignKey
ALTER TABLE "command_output" ADD CONSTRAINT "command_output_command_id_fkey" FOREIGN KEY ("command_id") REFERENCES "command_history"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "command_output" ADD CONSTRAINT "command_output_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
