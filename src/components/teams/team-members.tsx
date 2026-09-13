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
  inviteMemberAction,
  revokeInviteAction,
  changeMemberRoleAction,
  removeMemberAction,
  acceptInviteAction,
  type ActionState,
} from "@/app/_actions/teams";
import { CopyIcon, CheckIcon } from "lucide-react";

export interface MemberRow {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  roleId: string;
  roleName: string;
  roleRank: number;
  joinedAt: string;
}

export interface InviteRow {
  id: string;
  email: string;
  roleName: string;
  expiresAt: string;
}

export interface RoleOption {
  id: string;
  name: string;
  rank: number;
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Working…" : label}
    </Button>
  );
}

function InviteLink({ token, email }: { token: string; email: string }) {
  const [copied, setCopied] = useState(false);
  const url =
    typeof window !== "undefined"
      ? `${window.location.origin}/invite/${token}`
      : token;

  return (
    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <p className="text-sm font-medium">
        Invite for {email} — copy it now, it is shown only once.
      </p>
      <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
        <code>{url}</code>
      </pre>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          void navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Copied" : "Copy invite link"}
      </Button>
    </div>
  );
}

export function TeamMembers({
  members,
  invites,
  roles,
  currentUserId,
  currentRank,
  canManage,
}: {
  members: MemberRow[];
  invites: InviteRow[];
  roles: RoleOption[];
  currentUserId: string;
  currentRank: number;
  canManage: boolean;
}) {
  const [inviteState, inviteFormAction] = useActionState<ActionState, FormData>(
    inviteMemberAction,
    {},
  );
  const [acceptState, acceptFormAction] = useActionState<ActionState, FormData>(
    acceptInviteAction,
    {},
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // A member may only assign roles strictly below their own rank.
  const assignable = roles.filter((r) => r.rank < currentRank);

  // Base UI renders the raw value unless it is told how to label it, which
  // would otherwise surface internal ids in the trigger.
  const roleLabels = Object.fromEntries(roles.map((r) => [r.id, r.name]));

  const run = (fn: () => Promise<ActionState>) =>
    startTransition(async () => {
      const result = await fn();
      setError(result.error ?? null);
    });

  return (
    <div className="space-y-6">
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Invite a teammate</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <form action={inviteFormAction} className="flex flex-wrap gap-2">
              <Input
                name="email"
                type="email"
                placeholder="teammate@example.com"
                required
                className="max-w-xs"
              />
              <Select
                name="roleId"
                defaultValue={assignable.at(-1)?.id}
                items={roleLabels}
              >
                <SelectTrigger className="w-44" size="sm">
                  <SelectValue placeholder="Role" />
                </SelectTrigger>
                <SelectContent>
                  {assignable.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <SubmitButton label="Send invite" />
            </form>
            {inviteState.error && (
              <p className="text-sm text-destructive">{inviteState.error}</p>
            )}
            {inviteState.inviteToken && inviteState.inviteEmail && (
              <InviteLink
                token={inviteState.inviteToken}
                email={inviteState.inviteEmail}
              />
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Members ({members.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {members.map((member) => {
            const isSelf = member.userId === currentUserId;
            // Authority rule, mirrored from the server.
            const editable = canManage && !isSelf && member.roleRank < currentRank;
            return (
              <div
                key={member.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {member.name ?? member.email}
                    {isSelf && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        (you)
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {member.email}
                  </p>
                </div>

                {editable ? (
                  <Select
                    value={member.roleId}
                    items={roleLabels}
                    onValueChange={(value) => {
                      if (value && value !== member.roleId) {
                        run(() => changeMemberRoleAction(member.id, value));
                      }
                    }}
                  >
                    <SelectTrigger className="w-40" size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {assignable.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="secondary">{member.roleName}</Badge>
                )}

                {editable && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => run(() => removeMemberAction(member.id))}
                  >
                    Remove
                  </Button>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {canManage && invites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pending invites</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {invites.map((invite) => (
              <div
                key={invite.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">{invite.email}</span>
                <Badge variant="secondary">{invite.roleName}</Badge>
                <span className="text-xs text-muted-foreground">
                  expires {new Date(invite.expiresAt).toLocaleDateString()}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => run(() => revokeInviteAction(invite.id))}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Join another team</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form action={acceptFormAction} className="flex flex-wrap gap-2">
            <Input
              name="token"
              placeholder="Paste an invite link or token"
              className="min-w-64 flex-1"
            />
            <SubmitButton label="Accept invite" />
          </form>
          {acceptState.error && (
            <p className="text-sm text-destructive">{acceptState.error}</p>
          )}
          {acceptState.ok && (
            <p className="text-sm text-emerald-600">Invite accepted.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
