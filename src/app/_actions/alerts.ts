"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AlertMetric } from "@/generated/prisma/enums";
import { requirePermission } from "@/server/modules/teams/context";
import {
  AlertError,
  createRule,
  deleteRule,
  setRuleEnabled,
  setNotificationSettings,
  clearTelegram,
  sendTestNotification,
} from "@/server/modules/alerts/alert.service";

export interface AlertActionState {
  ok?: boolean;
  error?: string;
}

function fail(err: unknown): AlertActionState {
  if (err instanceof AlertError) return { error: err.message };
  if (err instanceof Error && err.name === "ForbiddenError") {
    return { error: "You do not have permission to do that" };
  }
  throw err;
}

const ruleSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  metric: z.enum(["CPU", "MEMORY", "DISK", "OFFLINE"]),
  threshold: z.coerce.number().min(1).max(100).default(90),
  forMinutes: z.coerce.number().int().min(1).max(1440).default(5),
  webhookUrl: z.string().trim().max(500).optional(),
});

export async function createRuleAction(
  _prev: AlertActionState,
  formData: FormData,
): Promise<AlertActionState> {
  // Alerts describe the fleet, so they follow device visibility rather than
  // execution rights.
  const ctx = await requirePermission("device:update");
  const parsed = ruleSchema.safeParse({
    name: formData.get("name"),
    metric: formData.get("metric"),
    threshold: formData.get("threshold") ?? 90,
    forMinutes: formData.get("forMinutes") ?? 5,
    webhookUrl: formData.get("webhookUrl") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    await createRule(ctx.user.id, ctx.team.id, {
      ...parsed.data,
      metric: parsed.data.metric as AlertMetric,
      webhookUrl: parsed.data.webhookUrl ?? null,
    });
    revalidatePath("/dashboard/alerts");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function toggleRuleAction(
  ruleId: string,
  enabled: boolean,
): Promise<AlertActionState> {
  const ctx = await requirePermission("device:update");
  try {
    await setRuleEnabled(ctx.user.id, ctx.team.id, ruleId, enabled);
    revalidatePath("/dashboard/alerts");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function deleteRuleAction(
  ruleId: string,
): Promise<AlertActionState> {
  const ctx = await requirePermission("device:update");
  try {
    await deleteRule(ctx.user.id, ctx.team.id, ruleId);
    revalidatePath("/dashboard/alerts");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function setNotificationsAction(
  _prev: AlertActionState,
  formData: FormData,
): Promise<AlertActionState> {
  const ctx = await requirePermission("team:manage_settings");
  try {
    await setNotificationSettings(ctx.user.id, ctx.team.id, {
      webhookUrl: formData.get("webhookUrl")?.toString().trim() || null,
      // Blank means "keep the stored token": it is never rendered back, so a
      // form submit must not silently clear it.
      telegramBotToken:
        formData.get("telegramBotToken")?.toString().trim() || null,
      telegramChatId:
        formData.get("telegramChatId")?.toString().trim() || null,
    });
    revalidatePath("/dashboard/alerts");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function clearTelegramAction(): Promise<AlertActionState> {
  const ctx = await requirePermission("team:manage_settings");
  try {
    await clearTelegram(ctx.user.id, ctx.team.id);
    revalidatePath("/dashboard/alerts");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function testNotificationAction(): Promise<
  AlertActionState & { report?: string }
> {
  const ctx = await requirePermission("team:manage_settings");
  try {
    const result = await sendTestNotification(ctx.team.id);
    const parts = [
      result.webhook ? `webhook: ${result.webhook}` : null,
      result.telegram ? `telegram: ${result.telegram}` : null,
    ].filter(Boolean);
    return {
      ok: true,
      report: parts.length ? parts.join(" · ") : "no channel configured yet",
    };
  } catch (err) {
    return fail(err);
  }
}
