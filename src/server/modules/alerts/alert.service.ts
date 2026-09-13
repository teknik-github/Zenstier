import "server-only";
import {
  AlertMetric,
  AlertState,
  AuditAction,
  DeviceStatus,
} from "@/generated/prisma/enums";
import { env } from "@/server/config/env";
import { prisma } from "@/server/infrastructure/db/prisma";
import { logger } from "@/server/infrastructure/logger/logger";

const log = logger.child({ module: "alerts" });

export class AlertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlertError";
  }
}

export const METRIC_LABELS: Record<AlertMetric, string> = {
  CPU: "CPU usage",
  MEMORY: "Memory usage",
  DISK: "Disk usage",
  OFFLINE: "Device offline",
};

export function listRules(teamId: string) {
  return prisma.alertRule.findMany({
    where: { teamId },
    orderBy: [{ enabled: "desc" }, { name: "asc" }],
    include: {
      states: {
        where: { state: AlertState.FIRING },
        include: { device: { select: { name: true, deviceId: true } } },
      },
    },
  });
}

export interface RuleInput {
  name: string;
  metric: AlertMetric;
  threshold: number;
  forMinutes: number;
  webhookUrl?: string | null;
}

export async function createRule(
  userId: string,
  teamId: string,
  input: RuleInput,
) {
  const name = input.name.trim();
  if (!name) throw new AlertError("Name is required");
  if (input.metric !== AlertMetric.OFFLINE) {
    if (input.threshold <= 0 || input.threshold > 100) {
      throw new AlertError("Threshold must be between 1 and 100 percent");
    }
  }
  if (input.webhookUrl && !/^https?:\/\//i.test(input.webhookUrl)) {
    throw new AlertError("Webhook URL must start with http:// or https://");
  }

  const rule = await prisma.alertRule.create({
    data: {
      teamId,
      userId,
      name,
      metric: input.metric,
      threshold: input.threshold,
      forMinutes: input.forMinutes,
      webhookUrl: input.webhookUrl?.trim() || null,
    },
  });

  await prisma.auditLog.create({
    data: {
      userId,
      teamId,
      action: AuditAction.ALERT_RULE_CREATED,
      targetType: "alert_rule",
      targetId: rule.id,
      metadata: { name, metric: input.metric, threshold: input.threshold },
    },
  });
  return rule;
}

export async function setRuleEnabled(
  userId: string,
  teamId: string,
  ruleId: string,
  enabled: boolean,
) {
  const rule = await prisma.alertRule.findFirst({
    where: { id: ruleId, teamId },
  });
  if (!rule) throw new AlertError("Rule not found");

  const updated = await prisma.alertRule.update({
    where: { id: ruleId },
    data: { enabled },
  });
  // Disabling clears state, so re-enabling starts from a clean slate rather
  // than immediately resolving alerts nobody saw fire.
  if (!enabled) {
    await prisma.alertRuleState.deleteMany({ where: { ruleId } });
  }
  await prisma.auditLog.create({
    data: {
      userId,
      teamId,
      action: AuditAction.ALERT_RULE_UPDATED,
      targetType: "alert_rule",
      targetId: ruleId,
      metadata: { name: rule.name, enabled },
    },
  });
  return updated;
}

export async function deleteRule(
  userId: string,
  teamId: string,
  ruleId: string,
) {
  const rule = await prisma.alertRule.findFirst({
    where: { id: ruleId, teamId },
  });
  if (!rule) throw new AlertError("Rule not found");
  await prisma.alertRule.delete({ where: { id: ruleId } });
  await prisma.auditLog.create({
    data: {
      userId,
      teamId,
      action: AuditAction.ALERT_RULE_DELETED,
      targetType: "alert_rule",
      targetId: ruleId,
      metadata: { name: rule.name },
    },
  });
}

export interface NotificationSettings {
  webhookUrl?: string | null;
  telegramBotToken?: string | null;
  telegramChatId?: string | null;
}

export async function setNotificationSettings(
  userId: string,
  teamId: string,
  input: NotificationSettings,
) {
  if (input.webhookUrl && !/^https?:\/\//i.test(input.webhookUrl)) {
    throw new AlertError("Webhook URL must start with http:// or https://");
  }
  if (input.telegramBotToken && !/^\d+:[\w-]{20,}$/.test(input.telegramBotToken)) {
    throw new AlertError(
      "That does not look like a Telegram bot token (expected 123456:ABC-…)",
    );
  }
  if (input.telegramBotToken && !input.telegramChatId) {
    throw new AlertError("A Telegram chat ID is required alongside the token");
  }

  await prisma.team.update({
    where: { id: teamId },
    data: {
      webhookUrl: input.webhookUrl ?? null,
      // An empty token means "leave it as it is": the UI never renders the
      // stored value back, so submitting the form must not wipe it.
      ...(input.telegramBotToken
        ? { telegramBotToken: input.telegramBotToken }
        : {}),
      telegramChatId: input.telegramChatId ?? null,
    },
  });

  await prisma.auditLog.create({
    data: {
      userId,
      teamId,
      action: AuditAction.TEAM_SETTINGS_UPDATED,
      targetType: "team",
      targetId: teamId,
      metadata: {
        webhook: input.webhookUrl ? "set" : "cleared",
        telegram: input.telegramChatId ? "set" : "cleared",
      },
    },
  });
}

export async function clearTelegram(userId: string, teamId: string) {
  await prisma.team.update({
    where: { id: teamId },
    data: { telegramBotToken: null, telegramChatId: null },
  });
  await prisma.auditLog.create({
    data: {
      userId,
      teamId,
      action: AuditAction.TEAM_SETTINGS_UPDATED,
      targetType: "team",
      targetId: teamId,
      metadata: { telegram: "cleared" },
    },
  });
}

/**
 * Sends a Telegram message.
 *
 * Plain text rather than Markdown or HTML on purpose: device names and metric
 * values are interpolated, and Telegram rejects the whole message on a single
 * unescaped entity — an alert that fails to arrive because a hostname
 * contained an underscore is worse than an unformatted one.
 */
async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${env.TELEGRAM_API_BASE.replace(/\/$/, "")}/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
      },
    );
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => ({}))) as {
      description?: string;
    };
    return {
      ok: false,
      // Telegram's description is safe to surface; the token is only ever in
      // the URL, never the body.
      error: body.description ?? `HTTP ${response.status}`,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Sends a sample alert, so a misconfigured chat id is caught at setup. */
export async function sendTestNotification(
  teamId: string,
): Promise<{ webhook?: string; telegram?: string }> {
  const team = await prisma.team.findUniqueOrThrow({
    where: { id: teamId },
    select: {
      name: true,
      webhookUrl: true,
      telegramBotToken: true,
      telegramChatId: true,
    },
  });
  const text = `🔔 Zenstier test alert from "${team.name}". If you can read this, notifications are working.`;
  const result: { webhook?: string; telegram?: string } = {};

  if (team.webhookUrl) {
    try {
      const r = await fetch(team.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ text, content: text }),
      });
      result.webhook = r.ok ? "delivered" : `rejected (HTTP ${r.status})`;
    } catch (err) {
      result.webhook = `failed: ${String(err)}`;
    }
  }

  if (team.telegramBotToken && team.telegramChatId) {
    const r = await sendTelegram(
      team.telegramBotToken,
      team.telegramChatId,
      text,
    );
    result.telegram = r.ok ? "delivered" : `failed: ${r.error}`;
  }

  return result;
}

// ── Evaluation ──────────────────────────────────────────────────────────────

interface Reading {
  deviceId: string;
  deviceName: string;
  value: number;
  breached: boolean;
}

/**
 * Evaluates every enabled rule and fires or resolves as needed.
 *
 * The `forMinutes` dwell is what makes this usable: without it a single spiky
 * sample pages someone at 03:00. A rule only fires once its condition has held
 * continuously, and resolves as soon as it stops.
 */
export async function evaluateAlerts(now: Date = new Date()): Promise<number> {
  const rules = await prisma.alertRule.findMany({ where: { enabled: true } });
  let fired = 0;

  for (const rule of rules) {
    const devices = await prisma.device.findMany({
      where: { teamId: rule.teamId },
      select: {
        id: true,
        name: true,
        status: true,
        lastSeenAt: true,
        metrics: { orderBy: { recordedAt: "desc" }, take: 1 },
      },
    });

    const readings: Reading[] = devices.map((d) => {
      if (rule.metric === AlertMetric.OFFLINE) {
        return {
          deviceId: d.id,
          deviceName: d.name,
          value: d.status === DeviceStatus.ONLINE ? 0 : 1,
          breached: d.status !== DeviceStatus.ONLINE,
        };
      }
      const m = d.metrics[0];
      // No sample yet is not a breach; it is an absence of evidence.
      if (!m) {
        return { deviceId: d.id, deviceName: d.name, value: 0, breached: false };
      }
      const value =
        rule.metric === AlertMetric.CPU
          ? m.cpuPercent
          : rule.metric === AlertMetric.MEMORY
            ? m.memPercent
            : m.diskPercent;
      return {
        deviceId: d.id,
        deviceName: d.name,
        value,
        breached: value >= rule.threshold,
      };
    });

    for (const reading of readings) {
      const existing = await prisma.alertRuleState.findUnique({
        where: {
          ruleId_deviceId: { ruleId: rule.id, deviceId: reading.deviceId },
        },
      });

      if (reading.breached) {
        const since = existing?.since ?? now;
        const heldFor = (now.getTime() - since.getTime()) / 60_000;
        const shouldFire =
          heldFor >= rule.forMinutes && existing?.state !== AlertState.FIRING;

        await prisma.alertRuleState.upsert({
          where: {
            ruleId_deviceId: { ruleId: rule.id, deviceId: reading.deviceId },
          },
          create: {
            ruleId: rule.id,
            deviceId: reading.deviceId,
            state: shouldFire ? AlertState.FIRING : AlertState.OK,
            since,
            lastValue: reading.value,
            firedAt: shouldFire ? now : null,
          },
          update: {
            state: shouldFire ? AlertState.FIRING : (existing?.state ?? AlertState.OK),
            since,
            lastValue: reading.value,
            ...(shouldFire ? { firedAt: now, resolvedAt: null } : {}),
          },
        });

        if (shouldFire) {
          fired += 1;
          await onFire(rule, reading, now);
        }
      } else if (existing) {
        const wasFiring = existing.state === AlertState.FIRING;
        await prisma.alertRuleState.update({
          where: { id: existing.id },
          data: {
            state: AlertState.OK,
            since: null,
            lastValue: reading.value,
            ...(wasFiring ? { resolvedAt: now } : {}),
          },
        });
        if (wasFiring) await onResolve(rule, reading, now);
      }
    }
  }

  return fired;
}

async function onFire(
  rule: { id: string; teamId: string; userId: string; name: string; metric: AlertMetric; threshold: number; webhookUrl: string | null },
  reading: Reading,
  now: Date,
) {
  log.warn("alert fired", {
    rule: rule.name,
    device: reading.deviceName,
    value: reading.value,
  });
  await prisma.auditLog.create({
    data: {
      userId: rule.userId,
      teamId: rule.teamId,
      action: AuditAction.ALERT_FIRED,
      targetType: "alert_rule",
      targetId: rule.id,
      metadata: {
        name: rule.name,
        device: reading.deviceName,
        metric: rule.metric,
        value: Math.round(reading.value),
      },
    },
  });
  await notify(rule, reading, "firing", now);
}

async function onResolve(
  rule: { id: string; teamId: string; name: string; metric: AlertMetric; threshold: number; webhookUrl: string | null },
  reading: Reading,
  now: Date,
) {
  log.info("alert resolved", { rule: rule.name, device: reading.deviceName });
  await notify(rule, reading, "resolved", now);
}

/**
 * Posts to the rule's webhook, falling back to the team's.
 *
 * The payload carries both a `text` field (which Slack and Discord render
 * directly) and structured fields, so one URL works for a chat channel or a
 * generic receiver without configuration.
 */
async function notify(
  rule: { teamId: string; name: string; metric: AlertMetric; threshold: number; webhookUrl: string | null },
  reading: Reading,
  state: "firing" | "resolved",
  now: Date,
) {
  const team = await prisma.team.findUnique({
    where: { id: rule.teamId },
    select: {
      webhookUrl: true,
      telegramBotToken: true,
      telegramChatId: true,
    },
  });
  const url = rule.webhookUrl ?? team?.webhookUrl ?? null;
  const telegramReady = Boolean(
    team?.telegramBotToken && team?.telegramChatId,
  );
  if (!url && !telegramReady) return;

  const unit = rule.metric === AlertMetric.OFFLINE ? "" : "%";
  const summary =
    state === "firing"
      ? rule.metric === AlertMetric.OFFLINE
        ? `🔴 ${reading.deviceName} is offline (${rule.name})`
        : `🔴 ${rule.name}: ${reading.deviceName} at ${Math.round(reading.value)}${unit} (threshold ${rule.threshold}${unit})`
      : rule.metric === AlertMetric.OFFLINE
        ? `✅ ${reading.deviceName} is back online (${rule.name})`
        : `✅ ${rule.name} resolved on ${reading.deviceName} (${Math.round(reading.value)}${unit})`;

  // Channels are independent: a broken webhook must not suppress Telegram,
  // and neither may stop alerts being evaluated or recorded.
  if (url) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          text: summary,
          content: summary, // Discord uses `content`
          zenstier: {
            state,
            rule: rule.name,
            metric: rule.metric,
            threshold: rule.threshold,
            device: reading.deviceName,
            value: reading.value,
            at: now.toISOString(),
          },
        }),
      });
      if (!response.ok) {
        log.warn("webhook rejected", { status: response.status });
      }
    } catch (err) {
      log.warn("webhook delivery failed", { error: String(err) });
    }
  }

  if (telegramReady) {
    const sent = await sendTelegram(
      team!.telegramBotToken!,
      team!.telegramChatId!,
      summary,
    );
    if (!sent.ok) {
      log.warn("telegram delivery failed", { error: sent.error });
    }
  }
}
