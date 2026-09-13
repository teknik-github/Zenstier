"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  createScheduleAction,
  deleteScheduleAction,
  previewCronAction,
  toggleScheduleAction,
  type ScheduleActionState,
} from "@/app/_actions/schedules";
import { useFormStatus } from "react-dom";
import { ClockIcon, PauseIcon, PlayIcon } from "lucide-react";

export interface ScheduleRow {
  id: string;
  name: string;
  command: string;
  cron: string;
  status: string;
  groupName: string | null;
  deviceNames: string[];
  lastRunAt: string | null;
  lastStatus: string | null;
  nextRunAt: string | null;
  runCount: number;
  owner: string;
}

export interface TargetOption {
  deviceId: string;
  name: string;
}
export interface GroupOption {
  id: string;
  name: string;
  deviceCount: number;
}

const NO_GROUP = "__none__";

const PRESETS: [string, string][] = [
  ["*/15 * * * *", "every 15 minutes"],
  ["0 * * * *", "hourly"],
  ["0 3 * * *", "daily at 03:00"],
  ["0 4 * * 0", "weekly, Sunday 04:00"],
  ["0 5 1 * *", "monthly, 1st at 05:00"],
];

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : "Create schedule"}
    </Button>
  );
}

export function ScheduleManager({
  schedules,
  devices,
  groups,
  canManage,
}: {
  schedules: ScheduleRow[];
  devices: TargetOption[];
  groups: GroupOption[];
  canManage: boolean;
}) {
  const [state, formAction] = React.useActionState<ScheduleActionState, FormData>(
    createScheduleAction,
    {},
  );
  const [cron, setCron] = React.useState("0 3 * * *");
  const [preview, setPreview] = React.useState<string | null>(null);
  const [group, setGroup] = React.useState(NO_GROUP);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  // Validate the expression as it is typed, so a typo never becomes a
  // schedule that silently never fires.
  React.useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await previewCronAction(cron);
      if (!cancelled) setPreview(result.error ? `✗ ${result.error}` : (result.preview ?? null));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [cron]);

  const run = (fn: () => Promise<ScheduleActionState>) =>
    startTransition(async () => {
      const result = await fn();
      setError(result.error ?? null);
    });

  const groupLabels: Record<string, string> = {
    [NO_GROUP]: "Specific devices",
    ...Object.fromEntries(groups.map((g) => [g.id, g.name])),
  };

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New schedule</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={formAction} className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Input name="name" placeholder="Name (e.g. nightly disk check)" required className="max-w-xs" />
                <Input
                  name="cron"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  placeholder="0 3 * * *"
                  required
                  className="max-w-40 font-mono"
                />
                <Input
                  name="timeoutMs"
                  type="number"
                  defaultValue={60000}
                  min={1000}
                  max={3600000}
                  className="w-28"
                  aria-label="Timeout in milliseconds"
                />
              </div>

              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map(([expr, label]) => (
                  <Button
                    key={expr}
                    type="button"
                    size="sm"
                    variant={cron === expr ? "default" : "outline"}
                    onClick={() => setCron(expr)}
                  >
                    {label}
                  </Button>
                ))}
              </div>

              {preview && (
                <p
                  className={`text-xs ${preview.startsWith("✗") ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {preview.startsWith("✗") ? preview : `Next runs (UTC): ${preview}`}
                </p>
              )}

              <Input name="command" placeholder="Command, e.g. df -h /" required className="font-mono" />

              <div className="flex flex-wrap items-center gap-2">
                <Select name="groupId" value={group} items={groupLabels} onValueChange={(v) => v && setGroup(v)}>
                  <SelectTrigger className="w-52" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_GROUP}>Specific devices</SelectItem>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name} ({g.deviceCount})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">
                  {group === NO_GROUP
                    ? "Targets are fixed to the devices you tick."
                    : "Targets resolve at run time, so devices added to the group are picked up automatically."}
                </span>
              </div>

              {group === NO_GROUP && (
                <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-3">
                  {devices.length === 0 && (
                    <p className="text-sm text-muted-foreground">No devices yet.</p>
                  )}
                  {devices.map((d) => (
                    <label key={d.deviceId} className="flex cursor-pointer items-center gap-2 rounded-md p-1.5 text-sm hover:bg-accent/50">
                      <Checkbox
                        name="deviceIds"
                        value={d.deviceId}
                        checked={selected.includes(d.deviceId)}
                        onCheckedChange={() =>
                          setSelected((prev) =>
                            prev.includes(d.deviceId)
                              ? prev.filter((x) => x !== d.deviceId)
                              : [...prev, d.deviceId],
                          )
                        }
                      />
                      <span className="truncate">{d.name}</span>
                    </label>
                  ))}
                </div>
              )}

              {state.error && <p className="text-sm text-destructive">{state.error}</p>}
              <SaveButton />
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Schedules ({schedules.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {schedules.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing scheduled yet. Everything here runs through the same
              dispatch path, rate limit and audit log as a hand-typed command.
            </p>
          ) : (
            schedules.map((s) => {
              const active = s.status === "ACTIVE";
              return (
                <div key={s.id} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <ClockIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="font-medium">{s.name}</span>
                    <Badge variant={active ? "default" : "secondary"}>
                      {active ? "active" : "paused"}
                    </Badge>
                    <code className="text-xs text-muted-foreground">{s.cron}</code>
                    <Badge variant="outline">
                      {s.groupName ? `group: ${s.groupName}` : `${s.deviceNames.length} device(s)`}
                    </Badge>
                    {canManage && (
                      <div className="ml-auto flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => run(() => toggleScheduleAction(s.id, !active))}
                        >
                          {active ? <PauseIcon /> : <PlayIcon />}
                          {active ? "Pause" : "Resume"}
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger
                            render={
                              <Button size="sm" variant="destructive" disabled={pending}>
                                Delete
                              </Button>
                            }
                          />
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete {s.name}?</AlertDialogTitle>
                              <AlertDialogDescription>
                                The schedule stops running. Commands it already
                                dispatched stay in the history and audit log.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                variant="destructive"
                                onClick={() => run(() => deleteScheduleAction(s.id))}
                              >
                                Delete schedule
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    )}
                  </div>

                  <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 font-mono text-xs">
                    {s.command}
                  </pre>

                  <p className="mt-2 text-xs text-muted-foreground">
                    {s.nextRunAt && active
                      ? `next ${new Date(s.nextRunAt).toISOString().replace("T", " ").slice(0, 16)} UTC · `
                      : ""}
                    ran {s.runCount}×
                    {s.lastRunAt
                      ? ` · last ${new Date(s.lastRunAt).toISOString().replace("T", " ").slice(0, 16)} UTC`
                      : ""}
                    {s.lastStatus ? ` · ${s.lastStatus}` : ""}
                    {` · by ${s.owner}`}
                  </p>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
