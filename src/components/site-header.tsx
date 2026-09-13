"use client"

import { usePathname } from "next/navigation"

import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { useEventStream } from "@/components/realtime/event-stream"

const TITLES: Record<string, string> = {
  "/dashboard": "Overview",
  "/dashboard/devices": "Devices",
  "/dashboard/console": "Console",
  "/dashboard/security": "Security",
  "/dashboard/alerts": "Alerts",
  "/dashboard/schedules": "Schedules",
  "/dashboard/ai": "AI console",
  "/dashboard/history": "Audit log",
  "/dashboard/team": "Team",
  "/dashboard/team/roles": "Roles & permissions",
  "/dashboard/team/settings": "Team settings",
  "/dashboard/devices/groups": "Broadcast groups",
}

export function SiteHeader() {
  const pathname = usePathname()
  const { connected } = useEventStream()
  const title = TITLES[pathname] ?? "Dashboard"

  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mx-2 h-4 data-vertical:self-auto"
        />
        <h1 className="text-base font-medium">{title}</h1>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={`size-1.5 rounded-full ${
              connected ? "bg-emerald-500" : "bg-muted-foreground/40"
            }`}
          />
          {connected ? "Live" : "Reconnecting"}
        </div>
      </div>
    </header>
  )
}
