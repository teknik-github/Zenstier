"use client";

import { useActionState, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
  renameTeamAction,
  deleteTeamAction,
  leaveTeamAction,
  type ActionState,
} from "@/app/_actions/teams";

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}

function DangerAction({
  title,
  description,
  confirmLabel,
  triggerLabel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  triggerLabel: string;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button variant="destructive" size="sm">
            {triggerLabel}
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
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

export function TeamSettings({
  team,
  deviceCount,
  memberCount,
  canManageSettings,
}: {
  team: { id: string; name: string; slug: string; isPersonal: boolean };
  deviceCount: number;
  memberCount: number;
  canManageSettings: boolean;
}) {
  const [renameState, renameFormAction] = useActionState<ActionState, FormData>(
    renameTeamAction,
    {},
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<ActionState>) =>
    startTransition(async () => {
      const result = await fn();
      setError(result?.error ?? null);
    });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Team name</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form action={renameFormAction} className="flex flex-wrap gap-2">
            <Input
              name="name"
              defaultValue={team.name}
              maxLength={80}
              required
              disabled={!canManageSettings}
              className="max-w-sm"
            />
            {canManageSettings && <SaveButton />}
          </form>
          <p className="text-xs text-muted-foreground">
            Identifier: <code>{team.slug}</code>
            {team.isPersonal && " · personal team"}
          </p>
          {renameState.error && (
            <p className="text-sm text-destructive">{renameState.error}</p>
          )}
          {renameState.ok && (
            <p className="text-sm text-emerald-600">Saved.</p>
          )}
          {!canManageSettings && (
            <p className="text-xs text-muted-foreground">
              Your role cannot change team settings.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Contents</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border p-3">
              <p className="text-2xl font-semibold tabular-nums">
                {deviceCount}
              </p>
              <p className="text-sm text-muted-foreground">devices</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-2xl font-semibold tabular-nums">
                {memberCount}
              </p>
              <p className="text-sm text-muted-foreground">members</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-base text-destructive">
            Danger zone
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p className="text-sm text-destructive">{error}</p>}

          {!team.isPersonal && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0">
                <p className="font-medium">Leave this team</p>
                <p className="text-sm text-muted-foreground">
                  You lose access to its devices and history. The last Owner
                  cannot leave.
                </p>
              </div>
              <DangerAction
                triggerLabel="Leave team"
                title={`Leave ${team.name}?`}
                description="You will no longer see this team's devices, command history or audit log. An Owner can invite you back."
                confirmLabel="Leave team"
                onConfirm={() => run(leaveTeamAction)}
              />
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <div className="min-w-0">
              <p className="font-medium">Delete this team</p>
              <p className="text-sm text-muted-foreground">
                {team.isPersonal
                  ? "Personal teams cannot be deleted."
                  : `Revokes broker credentials for all ${deviceCount} device(s), then permanently removes them along with every command and audit record.`}
              </p>
            </div>
            {canManageSettings && !team.isPersonal ? (
              <DangerAction
                triggerLabel="Delete team"
                title={`Delete ${team.name}?`}
                description={`Every one of the ${deviceCount} device(s) is disconnected from the broker and its credentials destroyed, then the team, its command history and its audit log are permanently removed. This cannot be undone.`}
                confirmLabel="Delete team and revoke all devices"
                onConfirm={() => run(deleteTeamAction)}
              />
            ) : (
              <Button variant="destructive" size="sm" disabled>
                Delete team
              </Button>
            )}
          </div>
          {pending && (
            <p className="text-sm text-muted-foreground">Working…</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
