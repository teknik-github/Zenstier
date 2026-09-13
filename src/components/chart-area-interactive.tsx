"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { useIsMobile } from "@/hooks/use-mobile"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useEventStream } from "@/components/realtime/event-stream"

export const description = "Fleet resource utilisation"

export interface MetricPoint {
  ts: string
  cpu: number
  memory: number
  disk: number
}

const chartConfig = {
  cpu: { label: "CPU", color: "var(--chart-1)" },
  memory: { label: "Memory", color: "var(--chart-2)" },
  disk: { label: "Disk", color: "var(--chart-3)" },
} satisfies ChartConfig

const RANGE_MINUTES: Record<string, number> = {
  "6h": 360,
  "1h": 60,
  "15m": 15,
}

export function ChartAreaInteractive({
  data,
  deviceIds,
}: {
  data: MetricPoint[]
  deviceIds: string[]
}) {
  const isMobile = useIsMobile()
  // null means "untouched", so the default can follow the viewport without an
  // effect writing state back during render.
  const [chosenRange, setTimeRange] = React.useState<string | null>(null)
  const timeRange = chosenRange ?? (isMobile ? "15m" : "6h")
  const { metrics } = useEventStream()

  // Append live heartbeat samples to the server-rendered history.
  const merged = React.useMemo(() => {
    const points = [...data]
    const live = deviceIds
      .map((id) => metrics[id])
      .filter((m): m is NonNullable<typeof m> => Boolean(m))

    if (live.length) {
      const latest = live.reduce(
        (acc, m) => ({
          cpu: acc.cpu + m.cpuPercent,
          memory: acc.memory + m.memPercent,
          disk: acc.disk + m.diskPercent,
          ts: m.recordedAt > acc.ts ? m.recordedAt : acc.ts,
        }),
        { cpu: 0, memory: 0, disk: 0, ts: new Date(0).toISOString() },
      )
      const point: MetricPoint = {
        ts: latest.ts,
        cpu: +(latest.cpu / live.length).toFixed(2),
        memory: +(latest.memory / live.length).toFixed(2),
        disk: +(latest.disk / live.length).toFixed(2),
      }
      if (points.at(-1)?.ts !== point.ts) points.push(point)
    }
    return points
  }, [data, metrics, deviceIds])

  const filteredData = React.useMemo(() => {
    const minutes = RANGE_MINUTES[timeRange] ?? 360
    const newest = merged.at(-1)
    if (!newest) return merged
    const cutoff = new Date(newest.ts).getTime() - minutes * 60_000
    return merged.filter((p) => new Date(p.ts).getTime() >= cutoff)
  }, [merged, timeRange])

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>Resource utilisation</CardTitle>
        <CardDescription>
          <span className="hidden @[540px]/card:block">
            Fleet average from agent heartbeats
          </span>
          <span className="@[540px]/card:hidden">Fleet average</span>
        </CardDescription>
        <CardAction>
          <ToggleGroup
            multiple={false}
            value={timeRange ? [timeRange] : []}
            onValueChange={(value) => {
              setTimeRange(value[0] ?? "6h")
            }}
            variant="outline"
            className="hidden *:data-[slot=toggle-group-item]:px-4! @[767px]/card:flex"
          >
            <ToggleGroupItem value="6h">Last 6 hours</ToggleGroupItem>
            <ToggleGroupItem value="1h">Last hour</ToggleGroupItem>
            <ToggleGroupItem value="15m">Last 15 min</ToggleGroupItem>
          </ToggleGroup>
          <Select
            value={timeRange}
            onValueChange={(value) => {
              if (value !== null) setTimeRange(value)
            }}
          >
            <SelectTrigger
              className="flex w-40 **:data-[slot=select-value]:block **:data-[slot=select-value]:truncate @[767px]/card:hidden"
              size="sm"
              aria-label="Select a range"
            >
              <SelectValue placeholder="Last 6 hours" />
            </SelectTrigger>
            <SelectContent className="rounded-xl">
              <SelectItem value="6h" className="rounded-lg">
                Last 6 hours
              </SelectItem>
              <SelectItem value="1h" className="rounded-lg">
                Last hour
              </SelectItem>
              <SelectItem value="15m" className="rounded-lg">
                Last 15 min
              </SelectItem>
            </SelectContent>
          </Select>
        </CardAction>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        {filteredData.length === 0 ? (
          <div className="flex h-[250px] items-center justify-center text-sm text-muted-foreground">
            Waiting for agent heartbeats…
          </div>
        ) : (
          <ChartContainer
            config={chartConfig}
            className="aspect-auto h-[250px] w-full"
          >
            <AreaChart data={filteredData}>
              <defs>
                <linearGradient id="fillCpu" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-cpu)" stopOpacity={1.0} />
                  <stop offset="95%" stopColor="var(--color-cpu)" stopOpacity={0.1} />
                </linearGradient>
                <linearGradient id="fillMemory" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-memory)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-memory)" stopOpacity={0.1} />
                </linearGradient>
                <linearGradient id="fillDisk" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-disk)" stopOpacity={0.6} />
                  <stop offset="95%" stopColor="var(--color-disk)" stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="ts"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
                tickFormatter={(value) =>
                  new Date(value).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                }
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                width={38}
                domain={[0, 100]}
                tickFormatter={(v) => `${v}%`}
              />
              <ChartTooltip
                cursor={false}
                defaultIndex={isMobile ? -1 : undefined}
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) =>
                      new Date(value).toLocaleString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })
                    }
                    indicator="dot"
                  />
                }
              />
              <Area
                dataKey="disk"
                type="natural"
                fill="url(#fillDisk)"
                stroke="var(--color-disk)"
                stackId="a"
              />
              <Area
                dataKey="memory"
                type="natural"
                fill="url(#fillMemory)"
                stroke="var(--color-memory)"
                stackId="b"
              />
              <Area
                dataKey="cpu"
                type="natural"
                fill="url(#fillCpu)"
                stroke="var(--color-cpu)"
                stackId="c"
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
