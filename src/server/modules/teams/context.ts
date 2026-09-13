import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { prisma } from "@/server/infrastructure/db/prisma";
import { requireUser, type SessionUser } from "@/server/modules/auth/session";
import type { Permission } from "./permissions";
import { ensurePersonalTeam } from "./team.service";

export class ForbiddenError extends Error {
  constructor(readonly permission: Permission) {
    super(`Missing permission: ${permission}`);
    this.name = "ForbiddenError";
  }
}

export interface TeamContext {
  user: SessionUser;
  team: { id: string; name: string; slug: string; isPersonal: boolean };
  role: { id: string; name: string; rank: number; isSystem: boolean };
  permissions: Set<Permission>;
  /** Non-throwing check, for conditionally rendering UI. */
  can: (permission: Permission) => boolean;
  /** Throwing check, for guarding an action. */
  require: (permission: Permission) => void;
}

/**
 * Resolves the caller's active team and effective permissions.
 *
 * Deduplicated per request with React `cache`, so a page and its nested server
 * components resolve membership once.
 */
export const getTeamContext = cache(async (): Promise<TeamContext> => {
  const user = await requireUser();

  let membership = await prisma.teamMember.findFirst({
    where: {
      userId: user.id,
      ...(await activeTeamFilter(user.id)),
    },
    include: { team: true, role: true },
  });

  // Fall back to any membership if the active team is stale or unset.
  membership ??= await prisma.teamMember.findFirst({
    where: { userId: user.id },
    include: { team: true, role: true },
    orderBy: { joinedAt: "asc" },
  });

  // A user with no team at all (e.g. registered before teams existed).
  if (!membership) {
    await ensurePersonalTeam(user.id, user.name ?? user.email.split("@")[0]!);
    membership = await prisma.teamMember.findFirstOrThrow({
      where: { userId: user.id },
      include: { team: true, role: true },
    });
  }

  const permissions = new Set(membership.role.permissions as Permission[]);

  return {
    user,
    team: {
      id: membership.team.id,
      name: membership.team.name,
      slug: membership.team.slug,
      isPersonal: membership.team.isPersonal,
    },
    role: {
      id: membership.role.id,
      name: membership.role.name,
      rank: membership.role.rank,
      isSystem: membership.role.isSystem,
    },
    permissions,
    can: (permission) => permissions.has(permission),
    require: (permission) => {
      if (!permissions.has(permission)) throw new ForbiddenError(permission);
    },
  };
});

async function activeTeamFilter(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { activeTeamId: true },
  });
  return user?.activeTeamId ? { teamId: user.activeTeamId } : {};
}

/**
 * Guards a Server Action or Route Handler.
 *
 * Server Actions are reachable by direct POST, so this must be called inside
 * every mutating action rather than relied upon at the routing layer.
 */
export async function requirePermission(
  permission: Permission,
): Promise<TeamContext> {
  const ctx = await getTeamContext();
  ctx.require(permission);
  return ctx;
}

/** Page-level guard that redirects rather than throwing. */
export async function requirePermissionPage(
  permission: Permission,
): Promise<TeamContext> {
  const ctx = await getTeamContext();
  if (!ctx.can(permission)) redirect("/dashboard?denied=" + permission);
  return ctx;
}
