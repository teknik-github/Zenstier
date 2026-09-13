"use client"

import * as React from "react"

import { NavDocuments } from "@/components/nav-documents"
import { NavMain } from "@/components/nav-main"
import { NavSecondary } from "@/components/nav-secondary"
import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar"
import {
  TeamSwitcher,
  type TeamOption,
} from "@/components/teams/team-switcher"
import {
  LayoutDashboardIcon,
  ServerIcon,
  TerminalIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  UsersIcon,
  ActivityIcon,
  KeyRoundIcon,
  Settings2Icon,
  CircleHelpIcon,
  SearchIcon,
  RadioTowerIcon,
} from "lucide-react"

const navMain = [
  {
    title: "Overview",
    url: "/dashboard",
    icon: <LayoutDashboardIcon />,
    permission: "device:read",
  },
  {
    title: "Devices",
    url: "/dashboard/devices",
    icon: <ServerIcon />,
    permission: "device:read",
  },
  {
    title: "Console",
    url: "/dashboard/console",
    icon: <TerminalIcon />,
    permission: "command:read",
  },
  {
    title: "Audit log",
    url: "/dashboard/history",
    icon: <ScrollTextIcon />,
    permission: "audit:read",
  },
  {
    title: "Team",
    url: "/dashboard/team",
    icon: <UsersIcon />,
    permission: "team:read",
  },
]

// NavMain highlights by prefix, so nested pages live here instead.

const documents = [
  {
    name: "Fleet health",
    url: "/dashboard",
    icon: <ActivityIcon />,
    permission: "device:read",
  },
  {
    name: "Enrollment tokens",
    url: "/dashboard/devices",
    icon: <KeyRoundIcon />,
    permission: "device:create",
  },
  {
    name: "Broadcast groups",
    url: "/dashboard/devices/groups",
    icon: <RadioTowerIcon />,
    permission: "device:read",
  },
  {
    name: "Roles & permissions",
    url: "/dashboard/team/roles",
    icon: <ShieldCheckIcon />,
    permission: "team:manage_roles",
  },
  {
    name: "Team settings",
    url: "/dashboard/team/settings",
    icon: <Settings2Icon />,
    permission: "team:read",
  },
]

const navSecondary = [
  { title: "Get Help", url: "#", icon: <CircleHelpIcon /> },
  { title: "Search", url: "#", icon: <SearchIcon /> },
]

export function AppSidebar({
  user,
  team,
  teams,
  permissions,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string; avatar: string }
  team: { id: string; name: string; slug: string; isPersonal: boolean }
  teams: TeamOption[]
  permissions: string[]
}) {
  const granted = new Set(permissions)
  // Nav mirrors the permission model: a link is only shown when the member
  // can actually use the page behind it.
  const visibleMain = navMain.filter(
    (item) => !item.permission || granted.has(item.permission),
  )
  const visibleDocs = documents.filter(
    (item) => !item.permission || granted.has(item.permission),
  )

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <TeamSwitcher teams={teams} activeTeamId={team.id} />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={visibleMain} canCreate={granted.has("device:create")} />
        <NavDocuments items={visibleDocs} />
        <NavSecondary items={navSecondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  )
}
