"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/modules/teams/context";
import { dispatchCommand } from "@/server/modules/commands/command.service";
import { dispatchCommandSchema } from "@/server/modules/commands/command.schema";
import { logger } from "@/server/infrastructure/logger/logger";

const log = logger.child({ module: "command-actions" });

export interface DispatchState {
  ok?: boolean;
  error?: string;
  batchId?: string;
  dispatched?: { deviceId: string; commandId: string }[];
  skipped?: { deviceId: string; reason: string }[];
}

export async function dispatchCommandAction(
  _prev: DispatchState,
  formData: FormData,
): Promise<DispatchState> {
  const ctx = await requirePermission("command:execute");

  const parsed = dispatchCommandSchema.safeParse({
    command: formData.get("command"),
    deviceIds: formData.getAll("deviceIds").map(String).filter(Boolean),
    timeoutMs: Number(formData.get("timeoutMs") ?? 60_000),
    useBroadcastTopic: formData.get("useBroadcastTopic") === "on",
    groupId: formData.get("groupId")?.toString() || null,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const result = await dispatchCommand(ctx.user.id, ctx.team.id, parsed.data);
    revalidatePath("/dashboard/console");
    return {
      ok: true,
      batchId: result.batchId,
      dispatched: result.dispatched,
      skipped: result.skipped,
    };
  } catch (err) {
    log.warn("dispatch rejected", { error: String(err) });
    return { error: err instanceof Error ? err.message : "Dispatch failed" };
  }
}

export interface RunResult {
  ok: boolean;
  error?: string;
  batchId?: string;
  dispatched: { deviceId: string; commandId: string }[];
  skipped: { deviceId: string; reason: string }[];
}

/**
 * REPL-style dispatch for the interactive console.
 *
 * Unlike `dispatchCommandAction` this is not a form action — the terminal
 * calls it directly so it can render each submission as its own scrollback
 * entry without a page-level form round trip.
 */
export async function runCommandAction(
  command: string,
  deviceIds: string[],
  timeoutMs = 60_000,
  target: { groupId?: string | null; broadcast?: boolean } = {},
): Promise<RunResult> {
  const ctx = await requirePermission("command:execute");

  const parsed = dispatchCommandSchema.safeParse({
    command,
    // A group broadcast resolves its own targets server-side.
    deviceIds: target.groupId ? [] : deviceIds,
    timeoutMs,
    useBroadcastTopic: Boolean(target.broadcast && target.groupId),
    groupId: target.groupId ?? null,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid command",
      dispatched: [],
      skipped: [],
    };
  }

  try {
    const result = await dispatchCommand(ctx.user.id, ctx.team.id, parsed.data);
    return {
      ok: true,
      batchId: result.batchId,
      dispatched: result.dispatched,
      skipped: result.skipped,
    };
  } catch (err) {
    log.warn("console dispatch rejected", { error: String(err) });
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Dispatch failed",
      dispatched: [],
      skipped: [],
    };
  }
}
