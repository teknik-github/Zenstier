"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePermission, getTeamContext } from "@/server/modules/teams/context";
import {
  TeamError,
  changeMemberRole,
  createRole,
  createTeam,
  deleteRole,
  inviteMember,
  removeMember,
  revokeInvite,
  switchActiveTeam,
  updateRole,
  acceptInvite,
  renameTeam,
  deleteTeam,
  leaveTeam,
} from "@/server/modules/teams/team.service";
import { PERMISSIONS } from "@/server/modules/teams/permissions";

export interface ActionState {
  ok?: boolean;
  error?: string;
  /** Shown once, never stored in plaintext. */
  inviteToken?: string;
  inviteEmail?: string;
}

function fail(err: unknown): ActionState {
  if (err instanceof TeamError) return { error: err.message };
  if (err instanceof Error && err.name === "ForbiddenError") {
    return { error: "You do not have permission to do that" };
  }
  throw err;
}

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  roleId: z.string().min(1, "Pick a role"),
});

export async function inviteMemberAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requirePermission("team:manage_members");
  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    roleId: formData.get("roleId"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const { token } = await inviteMember(
      ctx.user.id,
      ctx.role.rank,
      ctx.team.id,
      parsed.data.email,
      parsed.data.roleId,
    );
    revalidatePath("/dashboard/team");
    return { ok: true, inviteToken: token, inviteEmail: parsed.data.email };
  } catch (err) {
    return fail(err);
  }
}

export async function revokeInviteAction(inviteId: string): Promise<ActionState> {
  const ctx = await requirePermission("team:manage_members");
  try {
    await revokeInvite(ctx.user.id, ctx.team.id, inviteId);
    revalidatePath("/dashboard/team");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function changeMemberRoleAction(
  memberId: string,
  roleId: string,
): Promise<ActionState> {
  const ctx = await requirePermission("team:manage_members");
  try {
    await changeMemberRole(
      ctx.user.id,
      ctx.role.rank,
      ctx.team.id,
      memberId,
      roleId,
    );
    revalidatePath("/dashboard/team");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function removeMemberAction(memberId: string): Promise<ActionState> {
  const ctx = await requirePermission("team:manage_members");
  try {
    await removeMember(ctx.user.id, ctx.role.rank, ctx.team.id, memberId);
    revalidatePath("/dashboard/team");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

const roleSchema = z.object({
  name: z.string().trim().min(1, "Role name is required").max(60),
  description: z.string().trim().max(200).optional(),
  permissions: z.array(z.enum(PERMISSIONS)).default([]),
  rank: z.coerce.number().int().min(1).max(99),
});

export async function createRoleAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requirePermission("team:manage_roles");
  const parsed = roleSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") || undefined,
    permissions: formData.getAll("permissions").map(String),
    rank: formData.get("rank") ?? 20,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // A member must never be able to mint a role more powerful than their own.
  if (parsed.data.rank >= ctx.role.rank) {
    return { error: "You cannot create a role at or above your own rank" };
  }

  try {
    await createRole(ctx.user.id, ctx.team.id, parsed.data);
    revalidatePath("/dashboard/team/roles");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function updateRolePermissionsAction(
  roleId: string,
  permissions: string[],
): Promise<ActionState> {
  const ctx = await requirePermission("team:manage_roles");
  try {
    await updateRole(ctx.user.id, ctx.role.rank, ctx.team.id, roleId, {
      permissions,
    });
    revalidatePath("/dashboard/team/roles");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function deleteRoleAction(roleId: string): Promise<ActionState> {
  const ctx = await requirePermission("team:manage_roles");
  try {
    await deleteRole(ctx.user.id, ctx.role.rank, ctx.team.id, roleId);
    revalidatePath("/dashboard/team/roles");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

const createTeamSchema = z.object({
  name: z.string().trim().min(1, "Team name is required").max(80),
});

export async function createTeamAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  // Anyone signed in may start a team; they become its Owner.
  const ctx = await getTeamContext();
  const parsed = createTeamSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const team = await createTeam(ctx.user.id, parsed.data.name);
    await switchActiveTeam(ctx.user.id, team.id);
    revalidatePath("/dashboard", "layout");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function switchTeamAction(teamId: string): Promise<ActionState> {
  const ctx = await getTeamContext();
  try {
    await switchActiveTeam(ctx.user.id, teamId);
    revalidatePath("/dashboard", "layout");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function acceptInviteAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await getTeamContext();
  const token = String(formData.get("token") ?? "").trim();
  if (!token) return { error: "Paste an invite link or token" };

  try {
    await acceptInvite(ctx.user.id, token);
    revalidatePath("/dashboard", "layout");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}


// ── Team settings ───────────────────────────────────────────────────────────

const renameSchema = z.object({
  name: z.string().trim().min(1, "Team name is required").max(80),
});

export async function renameTeamAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requirePermission("team:manage_settings");
  const parsed = renameSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  try {
    await renameTeam(ctx.user.id, ctx.team.id, parsed.data.name);
    revalidatePath("/dashboard", "layout");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function deleteTeamAction(): Promise<ActionState> {
  const ctx = await requirePermission("team:manage_settings");
  try {
    await deleteTeam(ctx.user.id, ctx.team.id);
  } catch (err) {
    return fail(err);
  }
  // The caller no longer has a team context here, so leave the dashboard.
  redirect("/dashboard");
}

export async function leaveTeamAction(): Promise<ActionState> {
  const ctx = await getTeamContext();
  try {
    await leaveTeam(ctx.user.id, ctx.team.id);
  } catch (err) {
    return fail(err);
  }
  redirect("/dashboard");
}
