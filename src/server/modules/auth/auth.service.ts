import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { AuditAction } from "@/generated/prisma/enums";
import { env } from "@/server/config/env";
import { prisma } from "@/server/infrastructure/db/prisma";
import { logger } from "@/server/infrastructure/logger/logger";
import { hashPassword, verifyPassword } from "./password";
import type { RegisterInput } from "./auth.schema";

const log = logger.child({ module: "auth" });

export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super("An account with that email already exists");
    this.name = "EmailAlreadyRegisteredError";
  }
}

export class RegistrationClosedError extends Error {
  constructor() {
    super(
      "Sign-up is disabled on this server. Ask an administrator for an invite.",
    );
    this.name = "RegistrationClosedError";
  }
}

/**
 * Decides whether an email may create an account.
 *
 * Closing sign-up would otherwise break invites, since an invited person has
 * no account yet and so cannot accept one. A pending invite is therefore its
 * own authorisation to register — but only for the exact address it was sent
 * to.
 */
export async function mayRegister(email: string): Promise<boolean> {
  if (env.ALLOW_PUBLIC_REGISTRATION) return true;

  const invite = await prisma.teamInvite.findFirst({
    where: {
      email: email.toLowerCase(),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  return Boolean(invite);
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
}

export async function registerUser(
  input: RegisterInput,
): Promise<AuthenticatedUser> {
  if (!(await mayRegister(input.email))) {
    throw new RegistrationClosedError();
  }

  const passwordHash = await hashPassword(input.password);

  try {
    const user = await prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash,
      },
      select: { id: true, email: true, name: true },
    });

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: AuditAction.USER_REGISTERED,
        targetType: "user",
        targetId: user.id,
      },
    });

    // Every user owns a team from the moment they register; nothing in the
    // product is owned by a bare user account.
    const { ensurePersonalTeam } = await import(
      "@/server/modules/teams/team.service"
    );
    await ensurePersonalTeam(user.id, input.name);

    log.info("user registered", { userId: user.id });
    return user;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new EmailAlreadyRegisteredError();
    }
    throw err;
  }
}

/**
 * Verifies credentials. Returns null on any failure — the caller must not
 * distinguish "no such user" from "wrong password" in its response.
 */
export async function authenticateUser(
  email: string,
  password: string,
): Promise<AuthenticatedUser | null> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, passwordHash: true },
  });

  if (!user?.passwordHash) {
    // Equalise timing against the hash comparison below.
    await verifyPassword(password, "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv");
    return null;
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    log.warn("failed login", { email });
    return null;
  }

  return { id: user.id, email: user.email, name: user.name };
}
