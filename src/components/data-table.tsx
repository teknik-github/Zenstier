"use client"

import * as React from "react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useEventStream } from "@/components/realtime/event-stream"
import type { DeviceRow } from "@/components/devices/device-manager"
import { TerminalIcon } from "lucide-react"

function Meter({ value, label }: { value: number; label: string }) {
  // amber warns, red is reserved for genuinely critical
  const tone =
    value >= 90 ? "bg-destructive" : value >= 70 ? "bg-chart-3" : "bg-primary"
  return (
    <div className="flex min-w-28 items-center gap-2">
      <div
        className="h-1.5 w-16 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${label} ${value.toFixed(0)} percent`}
      >
        <div
          className={`h-full rounded-full ${tone}`}
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </div>
      <span className="tabular-nums text-xs text-muted-foreground">
        {value.toFixed(0)}%
      </span>
    </div>
  )
}

function formatUptime(seconds: number) {
  if (!seconds) return "—"
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

export function DataTable({ data }: { data: DeviceRow[] }) {
  const { status: liveStatus, metrics } = useEventStream()
  const [filter, setFilter] = React.useState("all")

  const rows = data.map((device) => {
    const status = liveStatus[device.deviceId]?.status ?? device.status
    // Live heartbeat wins; otherwise fall back to the last stored sample.
    const m = metrics[device.deviceId] ?? device.metrics ?? undefined
    return { device, status, m }
  })

  const visible = rows.filter(({ status }) =>
    filter === "all"
      ? true
      : filter === "online"
        ? status === "ONLINE"
        : status !== "ONLINE",
  )

  const counts = {
    all: rows.length,
    online: rows.filter((r) => r.status === "ONLINE").length,
    offline: rows.filter((r) => r.status !== "ONLINE").length,
  }

  return (
    <Tabs
      value={filter}
      onValueChange={(v) => setFilter(v ?? "all")}
      className="w-full flex-col justify-start gap-6"
    >
      <div className="flex items-center justify-between px-4 lg:px-6">
        <TabsList className="**:data-[slot=badge]:bg-muted-foreground/30 hidden **:data-[slot=badge]:size-5 **:data-[slot=badge]:rounded-full **:data-[slot=badge]:px-1 @4xl/main:flex">
          <TabsTrigger value="all">
            All devices <Badge variant="secondary">{counts.all}</Badge>
          </TabsTrigger>
          <TabsTrigger value="online">
            Online <Badge variant="secondary">{counts.online}</Badge>
          </TabsTrigger>
          <TabsTrigger value="offline">
            Offline <Badge variant="secondary">{counts.offline}</Badge>
          </TabsTrigger>
        </TabsList>

        <Select
          value={filter}
          items={{
            all: "All devices",
            online: "Online",
            offline: "Offline",
          }}
          onValueChange={(v) => v && setFilter(v)}
        >
          <SelectTrigger
            className="flex w-40 @4xl/main:hidden"
            size="sm"
            aria-label="Filter devices"
          >
            <SelectValue placeholder="All devices" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All devices</SelectItem>
            <SelectItem value="online">Online</SelectItem>
            <SelectItem value="offline">Offline</SelectItem>
          </SelectContent>
        </Select>

        <Button variant="outline" size="sm" render={<Link href="/dashboard/console" />}>
          <TerminalIcon />
          <span className="hidden lg:inline">Open console</span>
        </Button>
      </div>

      <TabsContent value={filter} className="relative flex flex-col gap-4 overflow-auto px-4 lg:px-6">
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="bg-muted sticky top-0 z-10">
              <TableRow>
                <TableHead>Device</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>OS</TableHead>
                <TableHead>CPU</TableHead>
                <TableHead>Memory</TableHead>
                <TableHead>Disk</TableHead>
                <TableHead className="text-right">Uptime</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                    No devices to show.
                  </TableCell>
                </TableRow>
              ) : (
                visible.map(({ device, status, m }) => (
                  <TableRow key={device.deviceId}>
                    <TableCell>
                      <div className="font-medium">{device.name}</div>
                      <div className="text-muted-foreground text-xs">
                        <code>{device.deviceId}</code>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className="gap-1.5 px-1.5 text-muted-foreground"
                      >
                        <span
                          className={`size-1.5 rounded-full ${
                            status === "ONLINE"
                              ? "bg-emerald-500"
                              : "bg-muted-foreground/40"
                          }`}
                        />
                        {status === "ONLINE" ? "Online" : "Offline"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {device.osName
                        ? `${device.osName} ${device.osVersion ?? ""}`
                        : "—"}
                      {device.arch ? ` · ${device.arch}` : ""}
                    </TableCell>
                    <TableCell>
                      {m ? <Meter value={m.cpuPercent} label="CPU" /> : "—"}
                    </TableCell>
                    <TableCell>
                      {m ? <Meter value={m.memPercent} label="Memory" /> : "—"}
                    </TableCell>
                    <TableCell>
                      {m ? <Meter value={m.diskPercent} label="Disk" /> : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                      {m ? formatUptime(m.uptimeSec) : "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </TabsContent>
    </Tabs>
  )
}
