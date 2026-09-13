"use client";

import { useActionState, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
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
  createGroupAction,
  deleteGroupAction,
  renameGroupAction,
  setDeviceGroupAction,
  type GroupActionState,
} from "@/app/_actions/groups";
import { RadioTowerIcon } from "lucide-react";

export interface GroupRow {
  id: string;
  name: string;
  devices: { deviceId: string; name: string; status: string }[];
}

export interface UngroupedDevice {
  deviceId: string;
  name: string;
  status: string;
}

const UNGROUPED = "__none__";

function CreateButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Creating…" : "Create group"}
    </Button>
  );
}

export function GroupManager({
  groups,
  devices,
  canEdit,
}: {
  groups: GroupRow[];
  /** Every device in the team, with its current group (null = ungrouped). */
  devices: (UngroupedDevice & { groupId: string | null })[];
  canEdit: boolean;
}) {
  const [createState, createFormAction] = useActionState<
    GroupActionState,
    FormData
  >(createGroupAction, {});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [renaming, setRenaming] = useState<Record<string, string>>({});

  // Without an explicit label map the trigger shows the raw group id.
  const groupLabels: Record<string, string> = {
    [UNGROUPED]: "No group",
    ...Object.fromEntries(groups.map((g) => [g.id, g.name])),
  };

  const run = (fn: () => Promise<GroupActionState>) =>
    startTransition(async () => {
      const result = await fn();
      setError(result.error ?? null);
    });

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Create a group</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <form action={createFormAction} className="flex flex-wrap gap-2">
              <Input
                name="name"
                placeholder="Group name (e.g. production-web)"
                required
                maxLength={60}
                className="max-w-sm"
              />
              <CreateButton />
            </form>
            {createState.error && (
              <p className="text-sm text-destructive">{createState.error}</p>
            )}
            <p className="text-xs text-muted-foreground">
              A group gets its own broadcast topic. Members can only{" "}
              <em>receive</em> on it — a device can never publish a command to
              its peers.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Groups ({groups.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No groups yet. Create one to broadcast a command to many devices
              with a single publish.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <RadioTowerIcon className="size-4 shrink-0 text-muted-foreground" />
                  {canEdit ? (
                    <Input
                      value={renaming[group.id] ?? group.name}
                      onChange={(e) =>
                        setRenaming((prev) => ({
                          ...prev,
                          [group.id]: e.target.value,
                        }))
                      }
                      onBlur={() => {
                        const next = renaming[group.id];
                        if (next && next !== group.name) {
                          run(() => renameGroupAction(group.id, next));
                        }
                      }}
                      className="h-8 max-w-xs"
                    />
                  ) : (
                    <span className="font-medium">{group.name}</span>
                  )}
                  <Badge variant="secondary">
                    {group.devices.length} device
                    {group.devices.length === 1 ? "" : "s"}
                  </Badge>
                  {canEdit && (
                    <AlertDialog>
                      <AlertDialogTrigger
                        render={
                          <Button
                            size="sm"
                            variant="outline"
                            className="ml-auto"
                            disabled={pending}
                          >
                            Delete
                          </Button>
                        }
                      />
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Delete group {group.name}?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            Its {group.devices.length} device(s) are removed
                            from the broadcast topic and the broker role is
                            destroyed. The devices themselves are untouched.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            variant="destructive"
                            onClick={() => run(() => deleteGroupAction(group.id))}
                          >
                            Delete group
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>

                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    MQTT topic
                  </summary>
                  <code className="mt-1 block break-all text-xs text-muted-foreground">
                    zenstier/broadcast/{group.id}/command
                  </code>
                </details>

                {group.devices.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {group.devices.map((d) => (
                      <Badge key={d.deviceId} variant="outline" className="gap-1.5">
                        <span
                          className={`size-1.5 rounded-full ${
                            d.status === "ONLINE"
                              ? "bg-emerald-500"
                              : "bg-muted-foreground/40"
                          }`}
                        />
                        {d.name}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Device membership</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No devices yet.</p>
          ) : (
            devices.map((device) => (
              <div
                key={device.deviceId}
                className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
              >
                <span
                  className={`size-2 shrink-0 rounded-full ${
                    device.status === "ONLINE"
                      ? "bg-emerald-500"
                      : "bg-muted-foreground/40"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{device.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    <code>{device.deviceId}</code>
                  </p>
                </div>
                <Select
                  value={device.groupId ?? UNGROUPED}
                  items={groupLabels}
                  disabled={!canEdit || pending}
                  onValueChange={(value) => {
                    if (!value) return;
                    const next = value === UNGROUPED ? null : value;
                    if (next === device.groupId) return;
                    run(() => setDeviceGroupAction(device.deviceId, next));
                  }}
                >
                  <SelectTrigger className="w-52" size="sm">
                    <SelectValue placeholder="No group" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNGROUPED}>No group</SelectItem>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
