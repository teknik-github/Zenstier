import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { AuditAction } from "@/generated/prisma/enums";
import { prisma } from "@/server/infrastructure/db/prisma";
import { logger } from "@/server/infrastructure/logger/logger";
import {
  OWNER_ROLE,
  SYSTEM_ROLES,
  isPermission,
  type Permission,
} from "./permissions";

const log = logger.child({ module: "teams" });

export class TeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamError";
  }
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "team"
  );
}

async function uniqueSlug(base: string): Promise<string> {
  const slug = slugify(base);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? slug : `${slug}-${i}`;
    const taken = await prisma.team.findUnique({ where: { slug: candidate } });
    if (!taken) return candidate;
  }
  return `${slug}-${randomBytes(4).toString("hex")}`;
}

/**
 * Creates a team, seeds its system roles, and makes `ownerId` the Owner.
 */
export async function createTeam(
  ownerId: string,
  name: string,
  { isPersonal = false }: { isPersonal?: boolean } = {},
) {
  const slug = await uniqueSlug(name);

  const team = await prisma.$transaction(async (tx) => {
    const created = await tx.team.create({
      data: { name, slug, isPersonal },
    });

    await tx.role.createMany({
      data: SYSTEM_ROLES.map((role) => ({
        teamId: created.id,
        name: role.name,
        description: role.description,
        permissions: role.permissions,
        rank: role.rank,
        isSystem: true,
      })),
    });

    const ownerRole = await tx.role.findFirstOrThrow({
      where: { teamId: created.id, name: OWNER_ROLE },
    });

    await tx.teamMember.create({
      data: { teamId: created.id, userId: ownerId, roleId: ownerRole.id },
    });

    await tx.auditLog.create({
      data: {
        userId: ownerId,
        teamId: created.id,
        action: AuditAction.TEAM_CREATED,
        targetType: "team",
        targetId: created.id,
        metadata: { name, isPersonal },
      },
    });

    return created;
  });

  log.info("team created", { teamId: team.id, slug: team.slug });
  return team;
}

/** Ensures a user has at least one team, creating a personal one if not. */
export async function ensurePersonalTeam(userId: string, displayName: string) {
  const existing = await prisma.teamMember.findFirst({
    where: { userId },
    include: { team: true },
  });
  if (existing) return existing.team;

  const team = await createTeam(userId, `${displayName}'s team`, {
    isPersonal: true,
  });
  await prisma.user.update({
    where: { id: userId },
    data: { activeTeamId: team.id },
  });
  return team;
}

export function listTeamsForUser(userId: string) {
  return prisma.teamMember.findMany({
    where: { userId },
    include: { team: true, role: true },
    orderBy: { joinedAt: "asc" },
  });
}

export function listMembers(teamId: string) {
  return prisma.teamMember.findMany({
    where: { teamId },
    include: {
      user: { select: { id: true, name: true, email: true } },
      role: true,
    },
    orderBy: [{ role: { rank: "desc" } }, { joinedAt: "asc" }],
  });
}

export function listRoles(teamId: string) {
  return prisma.role.findMany({
    where: { teamId },
    orderBy: [{ rank: "desc" }, { name: "asc" }],
    include: { _count: { select: { members: true } } },
  });
}

function validatePermissions(permissions: string[]): Permission[] {
  const invalid = permissions.filter((p) => !isPermission(p));
  if (invalid.length) {
    throw new TeamError(`Unknown permission(s): ${invalid.join(", ")}`);
  }
  return [...new Set(permissions)] as Permission[];
}

export async function createRole(
  actorId: string,
  teamId: string,
  input: { name: string; description?: string; permissions: string[]; rank: number },
) {
  const permissions = validatePermissions(input.permissions);
  const name = input.name.trim();
  if (!name) throw new TeamError("Role name is required");

  const clash = await prisma.role.findFirst({ where: { teamId, name } });
  if (clash) throw new TeamError(`A role named "${name}" already exists`);

  const role = await prisma.role.create({
    data: {
      teamId,
      name,
      description: input.description?.trim() || null,
      permissions,
      rank: input.rank,
      isSystem: false,
    },
  });

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      teamId,
      action: AuditAction.TEAM_ROLE_CREATED,
      targetType: "role",
      targetId: role.id,
      metadata: { name, permissions },
    },
  });
  return role;
}

export async function updateRole(
  actorId: string,
  actorRank: number,
  teamId: string,
  roleId: string,
  input: { name?: string; description?: string; permissions?: string[]; rank?: number },
) {
  const role = await prisma.role.findFirst({ where: { id: roleId, teamId } });
  if (!role) throw new TeamError("Role not found");

  // Authority check. Without this, anyone holding team:manage_roles could edit
  // their OWN role and grant themselves permissions they were never given —
  // privilege escalation. Hiding it in the UI is not enforcement.
  if (role.rank >= actorRank) {
    throw new TeamError("You cannot edit a role at or above your own rank");
  }
  // Nor may a new rank reach the actor's own authority.
  if (input.rank !== undefined && input.rank >= actorRank) {
    throw new TeamError("You cannot raise a role to or above your own rank");
  }

  // System roles keep their identity and authority; only a custom role can be
  // renamed or re-ranked. Owner must always retain every permission.
  if (role.isSystem && (input.name || input.rank !== undefined)) {
    throw new TeamError("System roles cannot be renamed or re-ranked");
  }
  if (role.name === OWNER_ROLE && input.permissions) {
    throw new TeamError("The Owner role must keep all permissions");
  }

  const permissions = input.permissions
    ? validatePermissions(input.permissions)
    : undefined;

  const updated = await prisma.role.update({
    where: { id: roleId },
    data: {
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined
        ? { description: input.description.trim() || null }
        : {}),
      ...(permissions ? { permissions } : {}),
      ...(input.rank !== undefined ? { rank: input.rank } : {}),
    },
  });

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      teamId,
      action: AuditAction.TEAM_ROLE_UPDATED,
      targetType: "role",
      targetId: roleId,
      metadata: { name: updated.name, permissions: updated.permissions },
    },
  });
  return updated;
}

export async function deleteRole(
  actorId: string,
  actorRank: number,
  teamId: string,
  roleId: string,
) {
  const role = await prisma.role.findFirst({
    where: { id: roleId, teamId },
    include: { _count: { select: { members: true } } },
  });
  if (!role) throw new TeamError("Role not found");
  if (role.rank >= actorRank) {
    throw new TeamError("You cannot delete a role at or above your own rank");
  }
  if (role.isSystem) throw new TeamError("System roles cannot be deleted");
  if (role._count.members > 0) {
    throw new TeamError(
      `${role._count.members} member(s) still use this role. Reassign them first.`,
    );
  }

  await prisma.role.delete({ where: { id: roleId } });
  await prisma.auditLog.create({
    data: {
      userId: actorId,
      teamId,
      action: AuditAction.TEAM_ROLE_DELETED,
      targetType: "role",
      targetId: roleId,
      metadata: { name: role.name },
    },
  });
}

// ── Membership ──────────────────────────────────────────────────────────────

export async function changeMemberRole(
  actorId: string,
  actorRank: number,
  teamId: string,
  memberId: string,
  roleId: string,
) {
  const member = await prisma.teamMember.findFirst({
    where: { id: memberId, teamId },
    include: { role: true },
  });
  if (!member) throw new TeamError("Member not found");

  const role = await prisma.role.findFirst({ where: { id: roleId, teamId } });
  if (!role) throw new TeamError("Role not found");

  // Authority check: you cannot touch a peer or senior, nor promote above
  // yourself. Without this, an Admin could grant themselves Owner.
  if (member.role.rank >= actorRank) {
    throw new TeamError("You cannot change the role of an equal or senior member");
  }
  if (role.rank >= actorRank) {
    throw new TeamError("You cannot assign a role at or above your own");
  }
  if (member.userId === actorId) {
    throw new TeamError("You cannot change your own role");
  }

  await ensureNotLastOwner(teamId, member.id, member.role.name);

  const updated = await prisma.teamMember.update({
    where: { id: memberId },
    data: { roleId },
  });

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      teamId,
      action: AuditAction.TEAM_MEMBER_ROLE_CHANGED,
      targetType: "member",
      targetId: memberId,
      metadata: { from: member.role.name, to: role.name },
    },
  });
  return updated;
}

export async function removeMember(
  actorId: string,
  actorRank: number,
  teamId: string,
  memberId: string,
) {
  const member = await prisma.teamMember.findFirst({
    where: { id: memberId, teamId },
    include: { role: true, user: { select: { email: true } } },
  });
  if (!member) throw new TeamError("Member not found");
  if (member.role.rank >= actorRank && member.userId !== actorId) {
    throw new TeamError("You cannot remove an equal or senior member");
  }
  await ensureNotLastOwner(teamId, member.id, member.role.name);

  await prisma.teamMember.delete({ where: { id: memberId } });

  // Leave no user pointing at a team they are no longer in.
  await prisma.user.updateMany({
    where: { id: member.userId, activeTeamId: teamId },
    data: { activeTeamId: null },
  });

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      teamId,
      action: AuditAction.TEAM_MEMBER_REMOVED,
      targetType: "member",
      targetId: memberId,
      metadata: { email: member.user.email },
    },
  });
}

/** A team must never be left without an Owner. */
async function ensureNotLastOwner(
  teamId: string,
  memberId: string,
  roleName: string,
) {
  if (roleName !== OWNER_ROLE) return;
  const owners = await prisma.teamMember.count({
    where: { teamId, role: { name: OWNER_ROLE } },
  });
  if (owners <= 1) {
    throw new TeamError("A team must always have at least one Owner");
  }
  void memberId;
}

// ── Invites ─────────────────────────────────────────────────────────────────

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function inviteMember(
  actorId: string,
  actorRank: number,
  teamId: string,
  email: string,
  roleId: string,
): Promise<{ token: string; inviteId: string }> {
  const normalised = email.trim().toLowerCase();
  const role = await prisma.role.findFirst({ where: { id: roleId, teamId } });
  if (!role) throw new TeamError("Role not found");
  if (role.rank >= actorRank) {
    throw new TeamError("You cannot invite someone at or above your own role");
  }

  const existingUser = await prisma.user.findUnique({
    where: { email: normalised },
  });
  if (existingUser) {
    const already = await prisma.teamMember.findFirst({
      where: { teamId, userId: existingUser.id },
    });
    if (already) throw new TeamError("That person is already a member");
  }

  const token = `zst_inv_${randomBytes(32).toString("base64url")}`;
  const invite = await prisma.teamInvite.upsert({
    where: { teamId_email: { teamId, email: normalised } },
    create: {
      teamId,
      email: normalised,
      roleId,
      tokenHash: hashInviteToken(token),
      invitedById: actorId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
    update: {
      roleId,
      tokenHash: hashInviteToken(token),
      invitedById: actorId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      acceptedAt: null,
      revokedAt: null,
    },
  });

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      teamId,
      action: AuditAction.TEAM_MEMBER_INVITED,
      targetType: "invite",
      targetId: invite.id,
      metadata: { email: normalised, role: role.name },
    },
  });

  return { token, inviteId: invite.id };
}

export function listInvites(teamId: string) {
  return prisma.teamInvite.findMany({
    where: { teamId, acceptedAt: null, revokedAt: null },
    include: { role: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function revokeInvite(
  actorId: string,
  teamId: string,
  inviteId: string,
) {
  const invite = await prisma.teamInvite.findFirst({
    where: { id: inviteId, teamId },
  });
  if (!invite) throw new TeamError("Invite not found");

  await prisma.teamInvite.update({
    where: { id: inviteId },
    data: { revokedAt: new Date() },
  });
  await prisma.auditLog.create({
    data: {
      userId: actorId,
      teamId,
      action: AuditAction.TEAM_INVITE_REVOKED,
      targetType: "invite",
      targetId: inviteId,
      metadata: { email: invite.email },
    },
  });
}

export async function acceptInvite(userId: string, token: string) {
  const invite = await prisma.teamInvite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    include: { team: true, role: true },
  });
  if (!invite) throw new TeamError("Invite link is not valid");
  if (invite.revokedAt) throw new TeamError("Invite has been revoked");
  if (invite.acceptedAt) throw new TeamError("Invite has already been used");
  if (invite.expiresAt < new Date()) throw new TeamError("Invite has expired");

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.email.toLowerCase() !== invite.email) {
    throw new TeamError(
      `This invite was issued for ${invite.email}. Sign in with that address to accept it.`,
    );
  }

  await prisma.$transaction([
    prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: invite.teamId, userId } },
      create: { teamId: invite.teamId, userId, roleId: invite.roleId },
      update: { roleId: invite.roleId },
    }),
    prisma.teamInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: userId },
      data: { activeTeamId: invite.teamId },
    }),
    prisma.auditLog.create({
      data: {
        userId,
        teamId: invite.teamId,
        action: AuditAction.TEAM_MEMBER_JOINED,
        targetType: "member",
        targetId: userId,
        metadata: { role: invite.role.name },
      },
    }),
  ]);

  return invite.team;
}

// ── Team settings ───────────────────────────────────────────────────────────

export async function renameTeam(
  actorId: string,
  teamId: string,
  name: string,
) {
  const trimmed = name.trim();
  if (!trimmed) throw new TeamError("Team name is required");

  const team = await prisma.team.update({
    where: { id: teamId },
    data: { name: trimmed },
  });

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      teamId,
      action: AuditAction.TEAM_SETTINGS_UPDATED,
      targetType: "team",
      targetId: teamId,
      metadata: { name: trimmed },
    },
  });
  return team;
}

/**
 * Deletes a team and everything it owns.
 *
 * Broker credentials are revoked BEFORE the rows are removed: deleting the
 * database records alone would leave every agent still connected and still
 * accepting commands, with nothing left to revoke them by.
 */
export async function deleteTeam(actorId: string, teamId: string) {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: { authTokens: true, devices: true },
  });
  if (!team) throw new TeamError("Team not found");
  if (team.isPersonal) {
    throw new TeamError("A personal team cannot be deleted");
  }

  const { dynsec, assertDynsecOk } = await import(
    "@/server/infrastructure/mqtt/dynsec"
  );
  const { clearRetainedStatus } = await import(
    "@/server/infrastructure/mqtt/publisher"
  );
  const { topics } = await import("@/lib/protocol");

  for (const token of team.authTokens) {
    try {
      assertDynsecOk(
        await dynsec.send([
          { command: "deleteClient", username: token.mqttUsername },
        ]),
        { tolerate: ["not found"] },
      );
    } catch (err) {
      // Never leave the team half-deleted with live credentials: abort so the
      // operator can retry rather than silently orphaning an agent.
      throw new TeamError(
        `Could not revoke credentials for ${token.mqttUsername}: ${String(err)}. Nothing was deleted.`,
      );
    }
  }

  // Evict retained presence so deleted devices stop appearing in snapshots.
  for (const device of team.devices) {
    await clearRetainedStatus(topics.status(device.deviceId)).catch(() => {});
  }

  // Detach anyone whose active team this was, then cascade the delete.
  await prisma.user.updateMany({
    where: { activeTeamId: teamId },
    data: { activeTeamId: null },
  });
  await prisma.team.delete({ where: { id: teamId } });

  log.warn("team deleted", {
    teamId,
    devices: team.devices.length,
    actorId,
  });
}

/** A member removing themselves. The last Owner may not leave. */
export async function leaveTeam(userId: string, teamId: string) {
  const membership = await prisma.teamMember.findFirst({
    where: { teamId, userId },
    include: { role: true, team: true },
  });
  if (!membership) throw new TeamError("You are not a member of that team");
  if (membership.team.isPersonal) {
    throw new TeamError("You cannot leave your personal team");
  }
  await ensureNotLastOwner(teamId, membership.id, membership.role.name);

  await prisma.teamMember.delete({ where: { id: membership.id } });
  await prisma.user.updateMany({
    where: { id: userId, activeTeamId: teamId },
    data: { activeTeamId: null },
  });
  await prisma.auditLog.create({
    data: {
      userId,
      teamId,
      action: AuditAction.TEAM_MEMBER_REMOVED,
      targetType: "member",
      targetId: membership.id,
      metadata: { self: true },
    },
  });
}

export async function switchActiveTeam(userId: string, teamId: string) {
  const membership = await prisma.teamMember.findFirst({
    where: { userId, teamId },
  });
  if (!membership) throw new TeamError("You are not a member of that team");
  await prisma.user.update({
    where: { id: userId },
    data: { activeTeamId: teamId },
  });
}
