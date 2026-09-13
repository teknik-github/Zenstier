"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createRuleAction,
  deleteRuleAction,
  setNotificationsAction,
  clearTelegramAction,
  testNotificationAction,
  toggleRuleAction,
  type AlertActionState,
} from "@/app/_actions/alerts";
import { useFormStatus } from "react-dom";
import { BellIcon, BellOffIcon, TriangleAlertIcon } from "lucide-react";

export interface FiringDevice {
  name: string;
  value: number;
  since: string | null;
}

export interface RuleRow {
  id: string;
  name: string;
  metric: string;
  threshold: number;
  forMinutes: number;
  enabled: boolean;
  webhookUrl: string | null;
  firing: FiringDevice[];
}

const METRIC_LABELS: Record<string, string> = {
  CPU: "CPU usage",
  MEMORY: "Memory usage",
  DISK: "Disk usage",
  OFFLINE: "Device offline",
};

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : label}
    </Button>
  );
}

export function AlertManager({
  rules,
  teamWebhook,
  telegramChatId,
  telegramConfigured,
  canManage,
  canManageSettings,
}: {
  rules: RuleRow[];
  teamWebhook: string | null;
  telegramChatId: string | null;
  telegramConfigured: boolean;
  canManage: boolean;
  canManageSettings: boolean;
}) {
  const [createState, createFormAction] = React.useActionState<
    AlertActionState,
    FormData
  >(createRuleAction, {});
  const [hookState, hookFormAction] = React.useActionState<
    AlertActionState,
    FormData
  >(setNotificationsAction, {});
  const [testReport, setTestReport] = React.useState<string | null>(null);
  const [metric, setMetric] = React.useState("DISK");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const run = (fn: () => Promise<AlertActionState>) =>
    startTransition(async () => {
      const r = await fn();
      setError(r.error ?? null);
    });

  const firingCount = rules.reduce((n, r) => n + r.firing.length, 0);
  const isOffline = metric === "OFFLINE";

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {firingCount > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium text-destructive">
              {firingCount} alert{firingCount === 1 ? "" : "s"} firing
            </p>
            <p className="text-muted-foreground">
              {rules
                .filter((r) => r.firing.length)
                .map((r) => `${r.name}: ${r.firing.map((f) => f.name).join(", ")}`)
                .join(" · ")}
            </p>
          </div>
        </div>
      )}

      {canManageSettings && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Where alerts are sent</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <form action={hookFormAction} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="webhookUrl" className="text-sm font-medium">
                  Webhook
                </label>
                <Input
                  id="webhookUrl"
                  name="webhookUrl"
                  defaultValue={teamWebhook ?? ""}
                  placeholder="https://hooks.slack.com/services/…"
                  className="max-w-xl"
                />
                <p className="text-xs text-muted-foreground">
                  Slack, Discord or any JSON receiver — the payload carries both
                  a rendered <code>text</code> field and structured data.
                </p>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="telegramChatId" className="text-sm font-medium">
                  Telegram{" "}
                  {telegramConfigured && (
                    <Badge variant="secondary">token stored</Badge>
                  )}
                </label>
                <div className="flex flex-wrap gap-2">
                  <Input
                    name="telegramBotToken"
                    type="password"
                    autoComplete="off"
                    placeholder={
                      telegramConfigured
                        ? "Bot token stored — leave blank to keep it"
                        : "Bot token from @BotFather (123456:ABC-…)"
                    }
                    className="max-w-sm"
                  />
                  <Input
                    id="telegramChatId"
                    name="telegramChatId"
                    defaultValue={telegramChatId ?? ""}
                    placeholder="Chat ID (e.g. -1001234567890)"
                    className="max-w-56"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Create a bot with @BotFather, add it to your group, then get
                  the chat ID from{" "}
                  <code>api.telegram.org/bot&lt;token&gt;/getUpdates</code>. The
                  token is stored write-only and never shown again.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <SubmitButton label="Save" />
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const r = await testNotificationAction();
                      setTestReport(r.report ?? r.error ?? null);
                    })
                  }
                >
                  Send test alert
                </Button>
                {telegramConfigured && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => run(clearTelegramAction)}
                  >
                    Remove Telegram
                  </Button>
                )}
              </div>
            </form>

            {testReport && (
              <p className="rounded-md bg-muted px-3 py-2 text-sm">
                {testReport}
              </p>
            )}
            {hookState.error && (
              <p className="text-sm text-destructive">{hookState.error}</p>
            )}
            {hookState.ok && <p className="text-sm text-emerald-600">Saved.</p>}
            <p className="text-xs text-muted-foreground">
              Channels are independent: a broken webhook never suppresses
              Telegram, and a failure in either never stops an alert being
              recorded.
            </p>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New alert rule</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={createFormAction} className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Input
                  name="name"
                  placeholder="Name (e.g. disk nearly full)"
                  required
                  className="max-w-xs"
                />
                <Select
                  name="metric"
                  value={metric}
                  items={METRIC_LABELS}
                  onValueChange={(v) => v && setMetric(v)}
                >
                  <SelectTrigger className="w-44" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(METRIC_LABELS).map(([k, label]) => (
                      <SelectItem key={k} value={k}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!isOffline && (
                  <div className="flex items-center gap-1">
                    <span className="text-sm text-muted-foreground">≥</span>
                    <Input
                      name="threshold"
                      type="number"
                      defaultValue={90}
                      min={1}
                      max={100}
                      className="w-20"
                      aria-label="Threshold percent"
                    />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>
                )}
                <div className="flex items-center gap-1">
                  <span className="text-sm text-muted-foreground">for</span>
                  <Input
                    name="forMinutes"
                    type="number"
                    defaultValue={5}
                    min={1}
                    max={1440}
                    className="w-20"
                    aria-label="Sustained minutes"
                  />
                  <span className="text-sm text-muted-foreground">min</span>
                </div>
                <SubmitButton label="Create rule" />
              </div>
              <Input
                name="webhookUrl"
                placeholder="Webhook for this rule (optional — falls back to the team's)"
                className="max-w-xl"
              />
              <p className="text-xs text-muted-foreground">
                The dwell time is what stops a single spiky sample paging anyone
                at 03:00 — the condition must hold continuously before it fires.
              </p>
              {createState.error && (
                <p className="text-sm text-destructive">{createState.error}</p>
              )}
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rules ({rules.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No rules yet. Metrics are collected either way — a rule is what
              turns them into something that reaches you.
            </p>
          ) : (
            rules.map((rule) => (
              <div
                key={rule.id}
                className={`rounded-lg border p-3 ${rule.firing.length ? "border-destructive/50 bg-destructive/5" : ""}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {rule.enabled ? (
                    <BellIcon className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <BellOffIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="font-medium">{rule.name}</span>
                  <Badge variant="outline">
                    {METRIC_LABELS[rule.metric] ?? rule.metric}
                    {rule.metric !== "OFFLINE" ? ` ≥ ${rule.threshold}%` : ""}
                    {` for ${rule.forMinutes}m`}
                  </Badge>
                  {!rule.enabled && <Badge variant="secondary">disabled</Badge>}
                  {rule.firing.length > 0 && (
                    <Badge variant="destructive">
                      firing on {rule.firing.length}
                    </Badge>
                  )}
                  {canManage && (
                    <div className="ml-auto flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => run(() => toggleRuleAction(rule.id, !rule.enabled))}
                      >
                        {rule.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={pending}
                        onClick={() => run(() => deleteRuleAction(rule.id))}
                      >
                        Delete
                      </Button>
                    </div>
                  )}
                </div>
                {rule.firing.length > 0 && (
                  <p className="mt-2 text-sm text-destructive">
                    {rule.firing
                      .map(
                        (f) =>
                          `${f.name} at ${Math.round(f.value)}${rule.metric === "OFFLINE" ? "" : "%"}`,
                      )
                      .join(" · ")}
                  </p>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
