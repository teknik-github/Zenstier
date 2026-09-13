import { requirePermissionPage } from "@/server/modules/teams/context";
import {
  listInvites,
  listMembers,
  listRoles,
} from "@/server/modules/teams/team.service";
import {
  TeamMembers,
  type InviteRow,
  type MemberRow,
  type RoleOption,
} from "@/components/teams/team-members";

export default async function TeamPage() {
  const ctx = await requirePermissionPage("team:read");

  const [members, roles, invites] = await Promise.all([
    listMembers(ctx.team.id),
    listRoles(ctx.team.id),
    ctx.can("team:manage_members") ? listInvites(ctx.team.id) : [],
  ]);

  const memberRows: MemberRow[] = members.map((m) => ({
    id: m.id,
    userId: m.userId,
    name: m.user.name,
    email: m.user.email,
    roleId: m.roleId,
    roleName: m.role.name,
    roleRank: m.role.rank,
    joinedAt: m.joinedAt.toISOString(),
  }));

  const inviteRows: InviteRow[] = invites.map((i) => ({
    id: i.id,
    email: i.email,
    roleName: i.role.name,
    expiresAt: i.expiresAt.toISOString(),
  }));

  const roleOptions: RoleOption[] = roles.map((r) => ({
    id: r.id,
    name: r.name,
    rank: r.rank,
  }));

  return (
    <div className="flex flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <p className="text-sm text-muted-foreground">
        {ctx.team.name} · you are {ctx.role.name}. Everything in Zenstier is
        owned by the team, so access follows membership.
      </p>
      <TeamMembers
        members={memberRows}
        invites={inviteRows}
        roles={roleOptions}
        currentUserId={ctx.user.id}
        currentRank={ctx.role.rank}
        canManage={ctx.can("team:manage_members")}
      />
    </div>
  );
}
