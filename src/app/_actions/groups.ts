"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/server/modules/teams/context";
import {
  GroupError,
  createGroup,
  deleteGroup,
  renameGroup,
  setDeviceGroup,
} from "@/server/modules/devices/group.service";
import { logger } from "@/server/infrastructure/logger/logger";

const log = logger.child({ module: "group-actions" });

export interface GroupActionState {
  ok?: boolean;
  error?: string;
}

function fail(err: unknown): GroupActionState {
  if (err instanceof GroupError) return { error: err.message };
  if (err instanceof Error && err.name === "ForbiddenError") {
    return { error: "You do not have permission to do that" };
  }
  log.error("group action failed", { error: String(err) });
  return { error: err instanceof Error ? err.message : "Something went wrong" };
}

const nameSchema = z.object({
  name: z.string().trim().min(1, "Group name is required").max(60),
});

export async function createGroupAction(
  _prev: GroupActionState,
  formData: FormData,
): Promise<GroupActionState> {
  // Grouping changes which devices a broadcast reaches, so it is gated on the
  // same permission as editing a device.
  const ctx = await requirePermission("device:update");
  const parsed = nameSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  try {
    await createGroup(ctx.user.id, ctx.team.id, parsed.data.name);
    revalidatePath("/dashboard/devices/groups");
    revalidatePath("/dashboard/console");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function renameGroupAction(
  groupId: string,
  name: string,
): Promise<GroupActionState> {
  const ctx = await requirePermission("device:update");
  const parsed = nameSchema.safeParse({ name });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  try {
    await renameGroup(ctx.user.id, ctx.team.id, groupId, parsed.data.name);
    revalidatePath("/dashboard/devices/groups");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function deleteGroupAction(
  groupId: string,
): Promise<GroupActionState> {
  const ctx = await requirePermission("device:update");
  try {
    await deleteGroup(ctx.user.id, ctx.team.id, groupId);
    revalidatePath("/dashboard/devices/groups");
    revalidatePath("/dashboard/console");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function setDeviceGroupAction(
  deviceId: string,
  groupId: string | null,
): Promise<GroupActionState> {
  const ctx = await requirePermission("device:update");
  try {
    await setDeviceGroup(ctx.user.id, ctx.team.id, deviceId, groupId);
    revalidatePath("/dashboard/devices/groups");
    revalidatePath("/dashboard/devices");
    revalidatePath("/dashboard/console");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
