import { getTeamContext } from "@/server/modules/teams/context";
import { listTeamsForUser } from "@/server/modules/teams/team.service";
import { prisma } from "@/server/infrastructure/db/prisma";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { EventStreamProvider } from "@/components/realtime/event-stream";

export default async function DashboardLayout({
  children,
}: LayoutProps<"/dashboard">) {
  const ctx = await getTeamContext();

  // One SSE connection for the whole dashboard: HTTP/1.1 allows only six
  // connections per origin, so a stream per page would starve navigation.
  const [devices, memberships] = await Promise.all([
    prisma.device.findMany({
      where: { teamId: ctx.team.id },
      select: { deviceId: true },
    }),
    listTeamsForUser(ctx.user.id),
  ]);

  return (
    <EventStreamProvider deviceIds={devices.map((d) => d.deviceId)}>
      <SidebarProvider
        style={
          {
            "--sidebar-width": "calc(var(--spacing) * 72)",
            "--header-height": "calc(var(--spacing) * 12)",
          } as React.CSSProperties
        }
      >
        <AppSidebar
          variant="inset"
          user={{
            name: ctx.user.name ?? "Account",
            email: ctx.user.email,
            avatar: "",
          }}
          team={ctx.team}
          teams={memberships.map((m) => ({
            id: m.team.id,
            name: m.team.name,
            roleName: m.role.name,
            isPersonal: m.team.isPersonal,
          }))}
          permissions={[...ctx.permissions]}
        />
        <SidebarInset>
          <SiteHeader />
          <div className="flex flex-1 flex-col">
            <div className="@container/main flex flex-1 flex-col gap-2">
              {children}
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </EventStreamProvider>
  );
}
