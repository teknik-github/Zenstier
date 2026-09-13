import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { AuditAction } from "@/generated/prisma/enums";
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

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
}

export async function registerUser(
  input: RegisterInput,
): Promise<AuthenticatedUser> {
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
