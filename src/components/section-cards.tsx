"use client"

import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  TrendingUpIcon,
  TrendingDownIcon,
  ServerIcon,
  CpuIcon,
  MemoryStickIcon,
  TerminalIcon,
} from "lucide-react"

export interface FleetSummary {
  totalDevices: number
  onlineDevices: number
  avgCpuPercent: number
  avgMemPercent: number
  commandsToday: number
  failuresToday: number
}

function pct(n: number) {
  return `${n.toFixed(1)}%`
}

export function SectionCards({ summary }: { summary: FleetSummary }) {
  const offline = summary.totalDevices - summary.onlineDevices
  const availability =
    summary.totalDevices === 0
      ? 0
      : (summary.onlineDevices / summary.totalDevices) * 100
  const successRate =
    summary.commandsToday === 0
      ? 100
      : ((summary.commandsToday - summary.failuresToday) /
          summary.commandsToday) *
        100

  return (
    <div className="grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:bg-linear-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
      <Card className="@container/card">
        <CardHeader>
          <CardDescription>Devices online</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {summary.onlineDevices} / {summary.totalDevices}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <ServerIcon />
              {pct(availability)}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            {offline === 0 ? (
              <>
                Whole fleet reachable <TrendingUpIcon className="size-4" />
              </>
            ) : (
              <>
                {offline} device{offline === 1 ? "" : "s"} offline{" "}
                <TrendingDownIcon className="size-4" />
              </>
            )}
          </div>
          <div className="text-muted-foreground">
            Presence via MQTT last will
          </div>
        </CardFooter>
      </Card>

      <Card className="@container/card">
        <CardHeader>
          <CardDescription>Average CPU</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {pct(summary.avgCpuPercent)}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <CpuIcon />
              {summary.avgCpuPercent > 80 ? "high" : "nominal"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            {summary.avgCpuPercent > 80 ? (
              <>
                Under sustained load <TrendingUpIcon className="size-4" />
              </>
            ) : (
              <>
                Headroom available <TrendingDownIcon className="size-4" />
              </>
            )}
          </div>
          <div className="text-muted-foreground">
            Across all reporting devices
          </div>
        </CardFooter>
      </Card>

      <Card className="@container/card">
        <CardHeader>
          <CardDescription>Average memory</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {pct(summary.avgMemPercent)}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <MemoryStickIcon />
              {summary.avgMemPercent > 85 ? "pressure" : "nominal"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            {summary.avgMemPercent > 85 ? (
              <>
                Memory pressure detected <TrendingUpIcon className="size-4" />
              </>
            ) : (
              <>
                Within normal range <TrendingDownIcon className="size-4" />
              </>
            )}
          </div>
          <div className="text-muted-foreground">
            Sampled on each agent heartbeat
          </div>
        </CardFooter>
      </Card>

      <Card className="@container/card">
        <CardHeader>
          <CardDescription>Commands today</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {summary.commandsToday}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <TerminalIcon />
              {pct(successRate)}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            {summary.failuresToday === 0 ? (
              <>
                All succeeded <TrendingUpIcon className="size-4" />
              </>
            ) : (
              <>
                {summary.failuresToday} failed{" "}
                <TrendingDownIcon className="size-4" />
              </>
            )}
          </div>
          <div className="text-muted-foreground">Every run is audit logged</div>
        </CardFooter>
      </Card>
    </div>
  )
}
