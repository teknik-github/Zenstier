-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'USER_2FA_ENABLED';
ALTER TYPE "AuditAction" ADD VALUE 'USER_2FA_DISABLED';
ALTER TYPE "AuditAction" ADD VALUE 'USER_2FA_RECOVERY_USED';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "totp_backup_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totp_secret" TEXT;
