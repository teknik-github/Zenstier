import "server-only";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { AuditAction, TokenStatus, DeviceStatus } from "@/generated/prisma/enums";
import { prisma } from "@/server/infrastructure/db/prisma";
import { logger } from "@/server/infrastructure/logger/logger";
import { dynsec, assertDynsecOk } from "@/server/infrastructure/mqtt/dynsec";
import { DEVICE_ROLE } from "@/server/infrastructure/mqtt/roles";
import { clearRetainedStatus } from "@/server/infrastructure/mqtt/publisher";
import { topics } from "@/lib/protocol";

const log = logger.child({ module: "tokens" });

const TOKEN_PREFIX = "zst_ent_";

/** URL-safe base64 without padding. */
function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Enrollment tokens are 256 bits of CSPRNG output, so a fast hash is correct:
 * they are not brute-forceable, and SHA-256 keeps the lookup O(1) and indexed.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Device ids appear as an MQTT topic level, so keep them alphanumeric. */
function generateDeviceId(): string {
  return `dev-${b64url(randomBytes(12)).replace(/[-_]/g, "").toLowerCase()}`;
}

export interface CreatedToken {
  tokenId: string;
  deviceId: string;
  /** Shown to the user exactly once. */
  plaintextToken: string;
}

/**
 * Creates a device slot plus its enrollment token, and pre-provisions a
 * DISABLED MQTT credential at the broker. The credential is only enabled when
 * an agent actually claims the token, so a leaked token that is never used
 * yields a credential that cannot connect.
 */
export async function createEnrollmentToken(
  userId: string,
  teamId: string,
  deviceName: string,
  label?: string,
  groupId?: string | null,
): Promise<CreatedToken> {
  const deviceId = generateDeviceId();
  const plaintextToken = `${TOKEN_PREFIX}${b64url(randomBytes(32))}`;
  const mqttPassword = b64url(randomBytes(32));

  const device = await prisma.device.create({
    data: {
      userId,
      teamId,
      deviceId,
      name: deviceName,
      status: DeviceStatus.UNKNOWN,
      groupId: groupId ?? null,
    },
  });

  const token = await prisma.authToken.create({
    data: {
      userId,
      teamId,
      deviceId: device.id,
      tokenPrefix: plaintextToken.slice(0, TOKEN_PREFIX.length + 8),
      tokenHash: hashToken(plaintextToken),
      mqttUsername: deviceId,
      mqttPasswordHash: await bcrypt.hash(mqttPassword, 10),
      status: TokenStatus.ACTIVE,
      label: label ?? null,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    },
  });

  // Stash the plaintext MQTT password only until enrollment consumes it.
  await stashPendingSecret(token.id, mqttPassword);

  await provisionBrokerCredential(deviceId, mqttPassword, groupId ?? null);

  await prisma.auditLog.create({
    data: {
      userId,
      teamId,
      action: AuditAction.TOKEN_CREATED,
      targetType: "device",
      targetId: device.id,
      metadata: { deviceId, label: label ?? null },
    },
  });

  log.info("enrollment token created", { deviceId, tokenId: token.id });
  return { tokenId: token.id, deviceId, plaintextToken };
}

/**
 * The MQTT password must reach the agent exactly once, at enrollment. Keeping
 * it in Redis under a short TTL avoids ever writing it to durable storage in
 * recoverable form.
 */
async function stashPendingSecret(tokenId: string, secret: string) {
  const { redis } = await import("@/server/infrastructure/events/bus");
  await redis().set(`zenstier:pending:${tokenId}`, secret, "EX", 60 * 60 * 24);
}

async function takePendingSecret(tokenId: string): Promise<string | null> {
  const { redis } = await import("@/server/infrastructure/events/bus");
  const key = `zenstier:pending:${tokenId}`;
  const value = await redis().get(key);
  if (value) await redis().del(key);
  return value;
}

async function provisionBrokerCredential(
  deviceId: string,
  password: string,
  groupId: string | null,
) {
  const { broadcastGroupName } = await import(
    "@/server/infrastructure/mqtt/roles"
  );

  assertDynsecOk(
    await dynsec.send([
      {
        command: "createClient",
        username: deviceId,
        password,
        // Pinning the client id stops a stolen credential from being replayed
        // under a different identity to dodge ACLs.
        clientid: deviceId,
        roles: [{ rolename: DEVICE_ROLE, priority: 0 }],
        ...(groupId
          ? { groups: [{ groupname: broadcastGroupName(groupId), priority: 0 }] }
          : {}),
      },
    ]),
  );

  // Created disabled; enrollment enables it.
  assertDynsecOk(
    await dynsec.send([{ command: "disableClient", username: deviceId }]),
  );
}

export interface EnrollmentResult {
  deviceId: string;
  mqttUsername: string;
  mqttPassword: string;
  groupId: string | null;
}

export class EnrollmentError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Exchanges a one-time enrollment token for live MQTT credentials. */
export async function consumeEnrollmentToken(
  plaintextToken: string,
  facts: {
    hostname?: string;
    osName?: string;
    osVersion?: string;
    kernel?: string;
    arch?: string;
    agentVersion?: string;
  },
): Promise<EnrollmentResult> {
  const token = await prisma.authToken.findUnique({
    where: { tokenHash: hashToken(plaintextToken) },
    include: { device: true },
  });

  if (!token || !token.device) {
    throw new EnrollmentError("Unknown enrollment token", "invalid_token", 401);
  }
  if (token.status === TokenStatus.REVOKED) {
    throw new EnrollmentError("Token has been revoked", "revoked", 403);
  }
  if (token.status === TokenStatus.CONSUMED) {
    throw new EnrollmentError(
      "Token has already been used",
      "already_used",
      409,
    );
  }
  if (token.expiresAt && token.expiresAt < new Date()) {
    throw new EnrollmentError("Token has expired", "expired", 401);
  }

  const mqttPassword = await takePendingSecret(token.id);
  if (!mqttPassword) {
    throw new EnrollmentError(
      "Enrollment secret is no longer available; revoke and re-issue the token",
      "secret_unavailable",
      409,
    );
  }

  // Enable the pre-provisioned broker credential.
  assertDynsecOk(
    await dynsec.send([
      { command: "enableClient", username: token.mqttUsername },
    ]),
  );

  await prisma.$transaction([
    prisma.authToken.update({
      where: { id: token.id },
      data: {
        status: TokenStatus.CONSUMED,
        consumedAt: new Date(),
        lastUsedAt: new Date(),
      },
    }),
    prisma.device.update({
      where: { id: token.device.id },
      data: {
        hostname: facts.hostname ?? null,
        osName: facts.osName ?? null,
        osVersion: facts.osVersion ?? null,
        kernel: facts.kernel ?? null,
        arch: facts.arch ?? null,
        agentVersion: facts.agentVersion ?? null,
      },
    }),
    prisma.auditLog.create({
      data: {
        userId: token.userId,
        teamId: token.teamId,
        action: AuditAction.DEVICE_ENROLLED,
        targetType: "device",
        targetId: token.device.id,
        metadata: { deviceId: token.device.deviceId, ...facts },
      },
    }),
  ]);

  log.info("device enrolled", { deviceId: token.device.deviceId });

  return {
    deviceId: token.device.deviceId,
    mqttUsername: token.mqttUsername,
    mqttPassword,
    groupId: token.device.groupId,
  };
}

/**
 * Revokes a device's credentials.
 *
 * `deleteClient` both removes the account and kicks any live session, so access
 * ends within a second rather than at the agent's next reconnect.
 */
export async function revokeToken(
  userId: string,
  teamId: string,
  tokenId: string,
): Promise<void> {
  // Scoped by team: any member with device:revoke may revoke, not only the
  // person who created the token.
  const token = await prisma.authToken.findFirst({
    where: { id: tokenId, teamId },
    include: { device: true },
  });
  if (!token) throw new Error("Token not found");

  assertDynsecOk(
    await dynsec.send([
      { command: "deleteClient", username: token.mqttUsername },
    ]),
    { tolerate: ["not found"] },
  );

  await prisma.$transaction([
    prisma.authToken.update({
      where: { id: token.id },
      data: { status: TokenStatus.REVOKED, revokedAt: new Date() },
    }),
    ...(token.device
      ? [
          prisma.device.update({
            where: { id: token.device.id },
            data: { status: DeviceStatus.OFFLINE },
          }),
        ]
      : []),
    prisma.auditLog.create({
      data: {
        userId,
        teamId,
        action: AuditAction.TOKEN_REVOKED,
        targetType: "device",
        targetId: token.deviceId,
        metadata: { deviceId: token.device?.deviceId },
      },
    }),
  ]);

  // Evict the retained status so the device stops appearing in fleet snapshots.
  if (token.device) {
    await clearRetainedStatus(topics.status(token.device.deviceId)).catch(
      (err) => log.warn("could not clear retained status", { error: String(err) }),
    );
  }

  await takePendingSecret(token.id);
  log.info("token revoked", { tokenId, deviceId: token.device?.deviceId });
}
