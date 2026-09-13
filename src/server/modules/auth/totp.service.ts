import "server-only";
import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import { AuditAction } from "@/generated/prisma/enums";
import { prisma } from "@/server/infrastructure/db/prisma";
import { logger } from "@/server/infrastructure/logger/logger";
import {
  generateBackupCodes,
  generateSecret,
  otpauthUri,
  verifyCode,
} from "./totp";

const log = logger.child({ module: "totp" });

export class TotpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TotpError";
  }
}

export interface TotpSetup {
  secret: string;
  otpauthUri: string;
  qrSvg: string;
}

/**
 * Starts enrolment.
 *
 * The secret is stored immediately but `totpEnabled` stays false until a code
 * is confirmed — otherwise a mis-scanned QR would lock the account out.
 */
export async function beginTotpSetup(
  userId: string,
  email: string,
): Promise<TotpSetup> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.totpEnabled) {
    throw new TotpError("Two-factor authentication is already enabled");
  }

  const secret = generateSecret();
  await prisma.user.update({
    where: { id: userId },
    data: { totpSecret: secret },
  });

  const uri = otpauthUri(secret, email);
  const qrSvg = await QRCode.toString(uri, {
    type: "svg",
    margin: 1,
    width: 200,
    errorCorrectionLevel: "M",
  });

  return { secret, otpauthUri: uri, qrSvg };
}

/** Confirms enrolment and returns the recovery codes, shown exactly once. */
export async function confirmTotpSetup(
  userId: string,
  code: string,
): Promise<string[]> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.totpEnabled) {
    throw new TotpError("Two-factor authentication is already enabled");
  }
  if (!user.totpSecret) {
    throw new TotpError("Start the setup again — no pending secret was found");
  }
  if (!verifyCode(user.totpSecret, code)) {
    throw new TotpError("That code is not valid. Check your device's clock.");
  }

  const codes = generateBackupCodes();
  const hashed = await Promise.all(codes.map((c) => bcrypt.hash(c, 10)));

  await prisma.user.update({
    where: { id: userId },
    data: { totpEnabled: true, totpBackupCodes: hashed },
  });
  await prisma.auditLog.create({
    data: {
      userId,
      action: AuditAction.USER_2FA_ENABLED,
      targetType: "user",
      targetId: userId,
    },
  });

  log.info("2fa enabled", { userId });
  return codes;
}

/** Disabling requires a current code, so a hijacked session cannot strip it. */
export async function disableTotp(userId: string, code: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.totpEnabled || !user.totpSecret) {
    throw new TotpError("Two-factor authentication is not enabled");
  }
  if (!(await verifySecondFactor(userId, code))) {
    throw new TotpError("That code is not valid");
  }

  await prisma.user.update({
    where: { id: userId },
    data: { totpEnabled: false, totpSecret: null, totpBackupCodes: [] },
  });
  await prisma.auditLog.create({
    data: {
      userId,
      action: AuditAction.USER_2FA_DISABLED,
      targetType: "user",
      targetId: userId,
    },
  });
  log.warn("2fa disabled", { userId });
}

/**
 * Verifies a TOTP code or a recovery code.
 *
 * A recovery code is consumed on use: leaving it valid would turn a written-
 * down list into a set of permanent passwords.
 */
export async function verifySecondFactor(
  userId: string,
  submitted: string,
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { totpSecret: true, totpEnabled: true, totpBackupCodes: true },
  });
  if (!user?.totpEnabled || !user.totpSecret) return true; // not enrolled

  const cleaned = submitted.trim();
  if (verifyCode(user.totpSecret, cleaned)) return true;

  const normalised = cleaned.toUpperCase();
  for (const hash of user.totpBackupCodes) {
    if (await bcrypt.compare(normalised, hash)) {
      await prisma.user.update({
        where: { id: userId },
        data: { totpBackupCodes: user.totpBackupCodes.filter((h) => h !== hash) },
      });
      await prisma.auditLog.create({
        data: {
          userId,
          action: AuditAction.USER_2FA_RECOVERY_USED,
          targetType: "user",
          targetId: userId,
          metadata: { remaining: user.totpBackupCodes.length - 1 },
        },
      });
      log.warn("2fa recovery code used", {
        userId,
        remaining: user.totpBackupCodes.length - 1,
      });
      return true;
    }
  }
  return false;
}

export async function totpStatus(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { totpEnabled: true, totpBackupCodes: true },
  });
  return {
    enabled: user.totpEnabled,
    backupCodesRemaining: user.totpBackupCodes.length,
  };
}
