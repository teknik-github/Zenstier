"use client";

import { useActionState, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
  createDeviceAction,
  revokeDeviceAction,
  deleteDeviceAction,
  type CreateDeviceState,
} from "@/app/_actions/devices";
import { useEventStream } from "@/components/realtime/event-stream";

export interface DeviceRow {
  deviceId: string;
  name: string;
  status: string;
  lastSeenAt: string | null;
  hostname: string | null;
  osName: string | null;
  osVersion: string | null;
  kernel: string | null;
  arch: string | null;
  agentVersion: string | null;
  enrolled: boolean;
  /** Broadcast group membership, used to expand a group into its devices. */
  groupId?: string | null;
  /** Most recent stored sample; live SSE updates supersede it. */
  metrics?: {
    cpuPercent: number;
    memPercent: number;
    diskPercent: number;
    load1: number;
    uptimeSec: number;
    processes: number;
    recordedAt: string;
  } | null;
}

function AddButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Provisioning…" : "Add device"}
    </Button>
  );
}

function EnrollmentInstructions({
  token,
  deviceId,
  serverUrl,
}: {
  token: string;
  deviceId: string;
  serverUrl: string;
}) {
  const [copied, setCopied] = useState(false);
  const command = `sudo zenstier enroll --token ${token} --server ${serverUrl}`;

  return (
    <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-start gap-2">
        <Badge variant="secondary">{deviceId}</Badge>
        <p className="text-sm font-medium">
          Copy this now — the token is shown only once.
        </p>
      </div>
      <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">
        <code>{command}</code>
      </pre>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          void navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? "Copied" : "Copy install command"}
      </Button>
    </div>
  );
}

function ConfirmAction({
  title,
  description,
  confirmLabel,
  trigger,
  onConfirm,
  destructive = false,
  disabled = false,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  trigger: React.ReactElement;
  onConfirm: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger disabled={disabled} render={trigger} />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeviceList({
  devices,
  canRevoke,
  canDelete,
}: {
  devices: DeviceRow[];
  canRevoke: boolean;
  canDelete: boolean;
}) {
  const { status: liveStatus } = useEventStream();
  const [pending, startTransition] = useTransition();

  if (devices.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No devices yet. Add one above to generate an enrollment token.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {devices.map((device) => {
        const live = liveStatus[device.deviceId];
        const status = live?.status ?? device.status;
        const isOnline = status === "ONLINE";
        const lastSeen = live?.lastSeenAt ?? device.lastSeenAt;

        return (
          <div
            key={device.deviceId}
            className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
          >
            <span
              className={`size-2.5 shrink-0 rounded-full ${
                isOnline ? "bg-emerald-500" : "bg-muted-foreground/40"
              }`}
              aria-label={isOnline ? "online" : "offline"}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate font-medium">{device.name}</p>
                {!device.enrolled && (
                  <Badge variant="outline" className="text-xs">
                    awaiting enrollment
                  </Badge>
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground">
                <code>{device.deviceId}</code>
                {device.osName && ` · ${device.osName} ${device.osVersion ?? ""}`}
                {device.arch && ` · ${device.arch}`}
                {device.kernel && ` · ${device.kernel}`}
              </p>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <p>{isOnline ? "Online" : "Offline"}</p>
              {lastSeen && (
                <p>last seen {new Date(lastSeen).toLocaleString()}</p>
              )}
            </div>
            <div className="flex gap-2">
              {canRevoke && (
              <ConfirmAction
                title={`Revoke access for ${device.name}?`}
                description="The device is disconnected from the broker immediately and its credentials stop working. The device stays listed and can be re-enrolled with a new token."
                confirmLabel="Revoke access"
                disabled={pending}
                onConfirm={() =>
                  startTransition(async () => {
                    await revokeDeviceAction(device.deviceId);
                  })
                }
                trigger={
                  <Button size="sm" variant="outline" disabled={pending}>
                    Revoke
                  </Button>
                }
              />
              )}
              {canDelete && (
              <ConfirmAction
                title={`Delete ${device.name}?`}
                description="Credentials are revoked immediately and the device, its command history and its metrics are permanently removed. This cannot be undone."
                confirmLabel="Delete device"
                destructive
                disabled={pending}
                onConfirm={() =>
                  startTransition(async () => {
                    await deleteDeviceAction(device.deviceId);
                  })
                }
                trigger={
                  <Button size="sm" variant="destructive" disabled={pending}>
                    Delete
                  </Button>
                }
              />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function DeviceManager({
  devices,
  serverUrl,
  canCreate,
  canRevoke,
  canDelete,
}: {
  devices: DeviceRow[];
  serverUrl: string;
  canCreate: boolean;
  canRevoke: boolean;
  canDelete: boolean;
}) {
  const [state, formAction] = useActionState<CreateDeviceState, FormData>(
    createDeviceAction,
    {},
  );

  return (
    <div className="space-y-6">
        {canCreate && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Enroll a new device</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <form action={formAction} className="flex flex-wrap gap-2">
              <Input
                name="name"
                placeholder="Device name (e.g. web-01)"
                required
                className="max-w-xs"
              />
              <Input
                name="label"
                placeholder="Note (optional)"
                className="max-w-xs"
              />
              <AddButton />
            </form>

            {state.error && (
              <p role="alert" className="text-sm text-destructive">
                {state.error}
              </p>
            )}

            {state.ok && state.token && state.deviceId && (
              <EnrollmentInstructions
                token={state.token}
                deviceId={state.deviceId}
                serverUrl={serverUrl}
              />
            )}
          </CardContent>
        </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Devices ({devices.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DeviceList
              devices={devices}
              canRevoke={canRevoke}
              canDelete={canDelete}
            />
          </CardContent>
        </Card>
    </div>
  );
}
