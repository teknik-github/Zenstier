"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ScheduleStatus } from "@/generated/prisma/enums";
import { requirePermission } from "@/server/modules/teams/context";
import {
  ScheduleError,
  createSchedule,
  deleteSchedule,
  nextRun,
  setScheduleStatus,
} from "@/server/modules/schedules/schedule.service";

export interface ScheduleActionState {
  ok?: boolean;
  error?: string;
  preview?: string;
}

function fail(err: unknown): ScheduleActionState {
  if (err instanceof ScheduleError) return { error: err.message };
  if (err instanceof Error && err.name === "ForbiddenError") {
    return { error: "You do not have permission to do that" };
  }
  throw err;
}

const createSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(80),
    command: z.string().trim().min(1, "Command is required").max(8192),
    cron: z.string().trim().min(1, "Cron expression is required").max(120),
    groupId: z.string().optional().nullable(),
    deviceIds: z.array(z.string()).default([]),
    timeoutMs: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
  })
  .refine((v) => v.groupId || v.deviceIds.length > 0, {
    message: "Pick at least one device, or a group",
    path: ["deviceIds"],
  });

export async function createScheduleAction(
  _prev: ScheduleActionState,
  formData: FormData,
): Promise<ScheduleActionState> {
  // Scheduling a command is running a command, deferred — so it is gated on
  // the same permission rather than inventing a weaker one.
  const ctx = await requirePermission("command:execute");

  const rawGroup = formData.get("groupId")?.toString();
  const parsed = createSchema.safeParse({
    name: formData.get("name"),
    command: formData.get("command"),
    cron: formData.get("cron"),
    groupId: rawGroup && rawGroup !== "__none__" ? rawGroup : null,
    deviceIds: formData.getAll("deviceIds").map(String).filter(Boolean),
    timeoutMs: formData.get("timeoutMs") ?? 60_000,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    await createSchedule(ctx.user.id, ctx.team.id, parsed.data);
    revalidatePath("/dashboard/schedules");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function toggleScheduleAction(
  scheduleId: string,
  active: boolean,
): Promise<ScheduleActionState> {
  const ctx = await requirePermission("command:execute");
  try {
    await setScheduleStatus(
      ctx.user.id,
      ctx.team.id,
      scheduleId,
      active ? ScheduleStatus.ACTIVE : ScheduleStatus.PAUSED,
    );
    revalidatePath("/dashboard/schedules");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function deleteScheduleAction(
  scheduleId: string,
): Promise<ScheduleActionState> {
  const ctx = await requirePermission("command:execute");
  try {
    await deleteSchedule(ctx.user.id, ctx.team.id, scheduleId);
    revalidatePath("/dashboard/schedules");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** Live validation for the cron field, so a typo is caught before saving. */
export async function previewCronAction(
  cron: string,
): Promise<ScheduleActionState> {
  await requirePermission("command:execute");
  try {
    const runs: string[] = [];
    let cursor = new Date();
    for (let i = 0; i < 3; i++) {
      cursor = nextRun(cron, cursor);
      runs.push(cursor.toISOString().replace("T", " ").slice(0, 16));
    }
    return { ok: true, preview: runs.join(" · ") };
  } catch (err) {
    return fail(err);
  }
}
