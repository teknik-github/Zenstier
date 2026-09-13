"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { createTeamAction, switchTeamAction } from "@/app/_actions/teams";
import {
  ChevronsUpDownIcon,
  CheckIcon,
  PlusIcon,
  ShieldCheckIcon,
} from "lucide-react";

export interface TeamOption {
  id: string;
  name: string;
  roleName: string;
  isPersonal: boolean;
}

function CreateButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Creating…" : "Create team"}
    </Button>
  );
}

export function TeamSwitcher({
  teams,
  activeTeamId,
}: {
  teams: TeamOption[];
  activeTeamId: string;
}) {
  const { isMobile } = useSidebar();
  const router = useRouter();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [switching, startSwitch] = React.useTransition();

  const active = teams.find((t) => t.id === activeTeamId) ?? teams[0];

  const switchTo = (teamId: string) => {
    if (teamId === activeTeamId) return;
    startSwitch(async () => {
      const result = await switchTeamAction(teamId);
      if (result.error) {
        setError(result.error);
        return;
      }
      // The sidebar, nav and every page are team-scoped, so refresh the whole
      // tree rather than trying to patch state in place.
      router.refresh();
    });
  };

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarMenuButton
                  size="lg"
                  className="aria-expanded:bg-muted"
                />
              }
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <ShieldCheckIcon className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">Zenstier</span>
                <span className="truncate text-xs text-muted-foreground">
                  {switching
                    ? "Switching…"
                    : `${active?.name ?? "No team"} · ${active?.roleName ?? "—"}`}
                </span>
              </div>
              <ChevronsUpDownIcon className="ml-auto size-4" />
            </DropdownMenuTrigger>

            <DropdownMenuContent
              className="min-w-60 rounded-lg"
              side={isMobile ? "bottom" : "right"}
              align="start"
              sideOffset={4}
            >
              {/* Base UI requires GroupLabel to live inside a Group. */}
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Teams
                </DropdownMenuLabel>
                {teams.map((team) => (
                  <DropdownMenuItem
                    key={team.id}
                    className="gap-2 p-2"
                    onClick={() => switchTo(team.id)}
                  >
                    <div className="flex size-6 items-center justify-center rounded-md border">
                      <ShieldCheckIcon className="size-3.5 shrink-0" />
                    </div>
                    <div className="grid min-w-0 flex-1">
                      <span className="truncate">{team.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {team.roleName}
                        {team.isPersonal ? " · personal" : ""}
                      </span>
                    </div>
                    {team.id === activeTeamId && (
                      <CheckIcon className="size-4 shrink-0" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2 p-2"
                onClick={() => setCreateOpen(true)}
              >
                <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                  <PlusIcon className="size-4" />
                </div>
                <span className="text-muted-foreground">Create team</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      {error && (
        <p className="px-2 pt-1 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <form
            action={async (formData) => {
              const result = await createTeamAction({}, formData);
              if (result.error) {
                setError(result.error);
                return;
              }
              setError(null);
              setCreateOpen(false);
              router.refresh();
            }}
          >
            <DialogHeader>
              <DialogTitle>Create a team</DialogTitle>
              <DialogDescription>
                You become its Owner. Devices, command history and audit records
                belong to the team, so teammates you invite see them too.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Input
                name="name"
                placeholder="Team name (e.g. Platform SRE)"
                required
                autoFocus
                maxLength={80}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <CreateButton />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
