-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'TEAM_SETTINGS_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'TEAM_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'DEVICE_GROUP_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'DEVICE_GROUP_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'DEVICE_GROUP_DELETED';
