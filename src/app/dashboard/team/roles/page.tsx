import { requirePermissionPage } from "@/server/modules/teams/context";
import { listRoles } from "@/server/modules/teams/team.service";
import { groupedCatalogue } from "@/server/modules/teams/permissions";
import {
  RoleEditor,
  type CatalogueGroup,
  type RoleRow,
} from "@/components/teams/role-editor";

export default async function RolesPage() {
  const ctx = await requirePermissionPage("team:read");
  const roles = await listRoles(ctx.team.id);

  const rows: RoleRow[] = roles.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    permissions: r.permissions,
    rank: r.rank,
    isSystem: r.isSystem,
    memberCount: r._count.members,
  }));

  const catalogue: CatalogueGroup[] = groupedCatalogue().map((g) => ({
    group: g.group,
    items: g.items.map((i) => ({
      key: i.key,
      label: i.label,
      description: i.description,
      sensitive: i.sensitive,
    })),
  }));

  return (
    <div className="flex flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <p className="text-sm text-muted-foreground">
        Roles are just named sets of permissions, so you can compose exactly the
        access a person needs.
      </p>
      <RoleEditor
        roles={rows}
        catalogue={catalogue}
        currentRank={ctx.role.rank}
        canManage={ctx.can("team:manage_roles")}
      />
    </div>
  );
}
