"use client";

import { useActionState, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  createRoleAction,
  deleteRoleAction,
  updateRolePermissionsAction,
  type ActionState,
} from "@/app/_actions/teams";
import { ShieldAlertIcon } from "lucide-react";

export interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  rank: number;
  isSystem: boolean;
  memberCount: number;
}

export interface CatalogueGroup {
  group: string;
  items: {
    key: string;
    label: string;
    description: string;
    sensitive?: boolean;
  }[];
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Working…" : label}
    </Button>
  );
}

function RoleCard({
  role,
  catalogue,
  editable,
  onError,
}: {
  role: RoleRow;
  catalogue: CatalogueGroup[];
  editable: boolean;
  onError: (message: string | null) => void;
}) {
  const [selected, setSelected] = useState<string[]>(role.permissions);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  const dirty =
    selected.length !== role.permissions.length ||
    selected.some((p) => !role.permissions.includes(p));

  const toggle = (key: string) =>
    setSelected((prev) =>
      prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key],
    );

  const save = () =>
    startTransition(async () => {
      const result = await updateRolePermissionsAction(role.id, selected);
      onError(result.error ?? null);
      if (result.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    });

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            {role.name}
            {role.isSystem && <Badge variant="secondary">system</Badge>}
            <Badge variant="outline">rank {role.rank}</Badge>
          </CardTitle>
          {role.description && (
            <p className="mt-1 text-sm text-muted-foreground">
              {role.description}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {role.memberCount} member{role.memberCount === 1 ? "" : "s"} ·{" "}
            {selected.length} permission{selected.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {editable && dirty && (
            <Button size="sm" onClick={save} disabled={pending}>
              Save
            </Button>
          )}
          {saved && (
            <span className="self-center text-xs text-emerald-600">Saved</span>
          )}
          {editable && !role.isSystem && role.memberCount === 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await deleteRoleAction(role.id);
                  onError(result.error ?? null);
                })
              }
            >
              Delete
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-5 md:grid-cols-3">
          {catalogue.map((group) => (
            <div key={group.group} className="space-y-2">
              <p className="text-xs font-semibold uppercase text-muted-foreground">
                {group.group}
              </p>
              {group.items.map((item) => {
                const checked = selected.includes(item.key);
                return (
                  <label
                    key={item.key}
                    className={`flex items-start gap-2 rounded-md p-1.5 text-sm ${
                      editable ? "cursor-pointer hover:bg-accent/50" : "opacity-70"
                    }`}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={!editable}
                      onCheckedChange={() => toggle(item.key)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 font-medium">
                        {item.label}
                        {item.sensitive && (
                          <ShieldAlertIcon className="size-3.5 text-amber-600" />
                        )}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {item.description}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function RoleEditor({
  roles,
  catalogue,
  currentRank,
  canManage,
}: {
  roles: RoleRow[];
  catalogue: CatalogueGroup[];
  currentRank: number;
  canManage: boolean;
}) {
  const [createState, createFormAction] = useActionState<ActionState, FormData>(
    createRoleAction,
    {},
  );
  const [error, setError] = useState<string | null>(null);

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
            <CardTitle className="text-base">Create a role</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <form action={createFormAction} className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Input
                  name="name"
                  placeholder="Role name (e.g. On-call engineer)"
                  required
                  className="max-w-xs"
                />
                <Input
                  name="description"
                  placeholder="What is it for? (optional)"
                  className="max-w-sm"
                />
                <Input
                  name="rank"
                  type="number"
                  min={1}
                  max={currentRank - 1}
                  defaultValue={Math.max(1, Math.min(20, currentRank - 1))}
                  className="w-24"
                  aria-label="Rank"
                />
                <SubmitButton label="Create role" />
              </div>
              <div className="grid gap-5 md:grid-cols-3">
                {catalogue.map((group) => (
                  <div key={group.group} className="space-y-2">
                    <p className="text-xs font-semibold uppercase text-muted-foreground">
                      {group.group}
                    </p>
                    {group.items.map((item) => (
                      <label
                        key={item.key}
                        className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 text-sm hover:bg-accent/50"
                      >
                        <Checkbox
                          name="permissions"
                          value={item.key}
                          className="mt-0.5"
                        />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5 font-medium">
                            {item.label}
                            {item.sensitive && (
                              <ShieldAlertIcon className="size-3.5 text-amber-600" />
                            )}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {item.description}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </form>
            {createState.error && (
              <p className="text-sm text-destructive">{createState.error}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Rank decides authority. You can only create, assign or edit roles
              ranked below your own ({currentRank}).
            </p>
          </CardContent>
        </Card>
      )}

      {roles.map((role) => (
        <RoleCard
          key={role.id}
          role={role}
          catalogue={catalogue}
          // Owner keeps every permission by definition, and nobody may edit a
          // role at or above their own rank.
          editable={canManage && role.rank < currentRank && role.name !== "Owner"}
          onError={setError}
        />
      ))}
    </div>
  );
}
