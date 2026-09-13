import { requirePermissionPage } from "@/server/modules/teams/context";
import { prisma } from "@/server/infrastructure/db/prisma";
import { listRules } from "@/server/modules/alerts/alert.service";
import { AlertManager, type RuleRow } from "@/components/alerts/alert-manager";

export default async function AlertsPage() {
  const ctx = await requirePermissionPage("device:read");

  const [rules, team] = await Promise.all([
    listRules(ctx.team.id),
    prisma.team.findUniqueOrThrow({
      where: { id: ctx.team.id },
      select: {
        webhookUrl: true,
        telegramChatId: true,
        telegramBotToken: true,
      },
    }),
  ]);

  const rows: RuleRow[] = rules.map((r) => ({
    id: r.id,
    name: r.name,
    metric: r.metric,
    threshold: r.threshold,
    forMinutes: r.forMinutes,
    enabled: r.enabled,
    webhookUrl: r.webhookUrl,
    firing: r.states.map((s) => ({
      name: s.device.name,
      value: s.lastValue,
      since: s.firedAt?.toISOString() ?? null,
    })),
  }));

  return (
    <div className="flex flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <p className="text-sm text-muted-foreground">
        Thresholds on the metrics agents already report. Evaluated once a
        minute; a rule fires only once its condition has held continuously, and
        resolves on its own.
      </p>
      <AlertManager
        rules={rows}
        teamWebhook={team.webhookUrl}
        telegramChatId={team.telegramChatId}
        // Only ever a boolean: the token itself never reaches the browser.
        telegramConfigured={Boolean(team.telegramBotToken)}
        canManage={ctx.can("device:update")}
        canManageSettings={ctx.can("team:manage_settings")}
      />
    </div>
  );
}
