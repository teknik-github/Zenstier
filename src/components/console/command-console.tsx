"use client"

import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { runCommandAction } from "@/app/_actions/commands"
import { useEventStream } from "@/components/realtime/event-stream"
import type { DeviceRow } from "@/components/devices/device-manager"
import { ChevronDownIcon, CheckIcon, TrashIcon } from "lucide-react"

/** One scrollback entry: the echoed command plus a pane per target device. */
interface Entry {
  id: number
  command: string
  at: string
  targets: { deviceId: string; name: string; commandId: string }[]
  error?: string
  skipped: { deviceId: string; reason: string }[]
}

const BANNER = [
  "Zenstier interactive console",
  "Commands run as root on the selected devices and are recorded in the audit log.",
  "Type `help` for console commands, or a shell command to run it.",
]

const HELP = [
  "  help              show this message",
  "  clear             clear the scrollback",
  "  targets           list selected devices",
  "  use <name|id>     select a single device",
  "  use all           select every online device",
  "  use group <name>  broadcast to a group (one publish, many devices)",
  "  use none          clear the selection",
  "  groups            list broadcast groups",
  "",
  "  Up / Down         browse command history",
  "  Ctrl+L            clear the scrollback",
  "  Ctrl+C            abandon the current input",
]

export interface ConsoleGroup {
  id: string
  name: string
  deviceCount: number
}

export function CommandConsole({
  devices,
  groups,
  canExecute,
}: {
  devices: DeviceRow[]
  groups: ConsoleGroup[]
  canExecute: boolean
}) {
  const { status: liveStatus, runs } = useEventStream()
  // null means the operator has not chosen yet, so a lone online device can be
  // preselected by derivation rather than by an effect writing state.
  const [chosen, setChosen] = React.useState<string[] | null>(null)
  // When set, dispatch goes out on the group's broadcast topic instead of
  // fanning out one publish per device.
  const [broadcast, setBroadcast] = React.useState<ConsoleGroup | null>(null)
  const [entries, setEntries] = React.useState<Entry[]>([])
  const [notes, setNotes] = React.useState<string[]>([])
  const [input, setInput] = React.useState("")
  const [history, setHistory] = React.useState<string[]>([])
  const [historyIndex, setHistoryIndex] = React.useState(-1)
  const [busy, setBusy] = React.useState(false)
  const [pickerOpen, setPickerOpen] = React.useState(false)

  const nextId = React.useRef(1)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  const statusOf = React.useCallback(
    (d: DeviceRow) => liveStatus[d.deviceId]?.status ?? d.status,
    [liveStatus],
  )

  const online = React.useMemo(
    () => devices.filter((d) => statusOf(d) === "ONLINE"),
    [devices, statusOf],
  )

  const selected = React.useMemo(
    () => chosen ?? (online.length === 1 ? [online[0]!.deviceId] : []),
    [chosen, online],
  )

  const setSelected = React.useCallback(
    (next: string[] | ((prev: string[]) => string[])) => {
      setChosen((prev) => {
        const current = prev ?? (online.length === 1 ? [online[0]!.deviceId] : [])
        return typeof next === "function" ? next(current) : next
      })
    },
    [online],
  )

  // Focus on mount so the console is typeable without a click.
  React.useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Follow the tail as output streams in.
  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries, runs, notes])

  const nameOf = React.useCallback(
    (deviceId: string) =>
      devices.find((d) => d.deviceId === deviceId)?.name ?? deviceId,
    [devices],
  )

  const note = (lines: string[]) => setNotes((prev) => [...prev, ...lines])

  const toggle = (deviceId: string) =>
    setSelected((prev) =>
      prev.includes(deviceId)
        ? prev.filter((d) => d !== deviceId)
        : [...prev, deviceId],
    )

  async function submit(raw: string) {
    const command = raw.trim()
    if (!command) return

    setHistory((prev) => [...prev, command])
    setHistoryIndex(-1)
    setInput("")

    // Built-in console commands never reach a device.
    const [verb, ...args] = command.split(/\s+/)
    switch (verb) {
      case "help":
        note([`$ ${command}`, ...HELP, ""])
        return
      case "clear":
        setEntries([])
        setNotes([])
        return
      case "targets":
        note([
          `$ ${command}`,
          broadcast
            ? `  broadcast -> ${broadcast.name} (${broadcast.deviceCount} device(s))`
            : selected.length
              ? selected.map((d) => `  ${nameOf(d)}  (${d})`).join("\n")
              : "  no devices selected",
          "",
        ])
        return
      case "groups":
        note([
          `$ ${command}`,
          groups.length
            ? groups
                .map((g) => `  ${g.name}  (${g.deviceCount} device(s))`)
                .join("\n")
            : "  no groups defined",
          "",
        ])
        return
      case "use": {
        const arg = args.join(" ")
        if (args[0] === "group") {
          const wanted = args.slice(1).join(" ")
          const group = groups.find(
            (g) => g.name.toLowerCase() === wanted.toLowerCase(),
          )
          if (!group) {
            note([`$ ${command}`, `  no group named "${wanted}"`, ""])
            return
          }
          setBroadcast(group)
          setSelected([])
          note([
            `$ ${command}`,
            `  broadcasting to ${group.name} (${group.deviceCount} device(s))`,
            "",
          ])
          return
        }
        if (arg === "all") {
          setBroadcast(null)
          setSelected(online.map((d) => d.deviceId))
          note([`$ ${command}`, `  selected ${online.length} online device(s)`, ""])
          return
        }
        if (arg === "none") {
          setSelected([])
          setBroadcast(null)
          note([`$ ${command}`, "  cleared the selection", ""])
          return
        }
        const match = devices.find(
          (d) => d.deviceId === arg || d.name.toLowerCase() === arg.toLowerCase(),
        )
        if (!match) {
          note([`$ ${command}`, `  no device matching "${arg}"`, ""])
          return
        }
        setBroadcast(null)
        setSelected([match.deviceId])
        note([`$ ${command}`, `  selected ${match.name}`, ""])
        return
      }
    }

    if (!canExecute) {
      note([
        `$ ${command}`,
        "  permission denied: your role does not allow running commands",
        "",
      ])
      return
    }

    if (selected.length === 0 && !broadcast) {
      note([
        `$ ${command}`,
        "  no target selected — use the Targets picker, `use <name>` or `use group <name>`",
        "",
      ])
      return
    }

    setBusy(true)
    const result = await runCommandAction(
      command,
      selected,
      60_000,
      broadcast ? { groupId: broadcast.id, broadcast: true } : {},
    )
    setBusy(false)
    // Re-assert focus: a re-render during dispatch can drop the caret.
    requestAnimationFrame(() => inputRef.current?.focus())

    setEntries((prev) => [
      ...prev,
      {
        id: nextId.current++,
        command,
        at: new Date().toISOString(),
        targets: result.dispatched.map((d) => ({
          deviceId: d.deviceId,
          name: nameOf(d.deviceId),
          commandId: d.commandId,
        })),
        error: result.error,
        skipped: result.skipped,
      },
    ])
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault()
      if (busy) return
      void submit(input)
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      if (history.length === 0) return
      const next = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(next)
      setInput(history[next] ?? "")
      return
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      if (historyIndex < 0) return
      const next = historyIndex + 1
      if (next >= history.length) {
        setHistoryIndex(-1)
        setInput("")
      } else {
        setHistoryIndex(next)
        setInput(history[next] ?? "")
      }
      return
    }
    if (event.ctrlKey && event.key.toLowerCase() === "l") {
      event.preventDefault()
      setEntries([])
      setNotes([])
      return
    }
    if (event.ctrlKey && event.key.toLowerCase() === "c") {
      event.preventDefault()
      note([`$ ${input}^C`])
      setInput("")
    }
  }

  const prompt = broadcast
    ? `@${broadcast.name}`
    : selected.length === 0
      ? "zenstier"
      : selected.length === 1
        ? nameOf(selected[0]!)
        : `${selected.length} devices`

  return (
    <div className="flex flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      {/* Target picker */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPickerOpen((v) => !v)}
        >
          Targets
          <Badge variant="secondary">{selected.length}</Badge>
          <ChevronDownIcon
            className={pickerOpen ? "rotate-180 transition-transform" : "transition-transform"}
          />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setBroadcast(null)
            setSelected(online.map((d) => d.deviceId))
          }}
        >
          Select all online ({online.length})
        </Button>
        {(selected.length > 0 || broadcast) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelected([])
              setBroadcast(null)
            }}
          >
            Clear
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEntries([])
              setNotes([])
            }}
          >
            <TrashIcon />
            <span className="hidden sm:inline">Clear output</span>
          </Button>
        </div>
      </div>

      {pickerOpen && groups.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
          <span className="text-xs font-medium text-muted-foreground">
            Broadcast groups
          </span>
          {groups.map((group) => (
            <Button
              key={group.id}
              size="sm"
              variant={broadcast?.id === group.id ? "default" : "outline"}
              onClick={() => {
                setBroadcast(broadcast?.id === group.id ? null : group)
                setSelected([])
              }}
            >
              {group.name}
              <Badge variant="secondary">{group.deviceCount}</Badge>
            </Button>
          ))}
        </div>
      )}

      {pickerOpen && (
        <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-3">
          {devices.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No devices enrolled yet.
            </p>
          )}
          {devices.map((device) => {
            const isOnline = statusOf(device) === "ONLINE"
            const isSelected = selected.includes(device.deviceId)
            return (
              <button
                key={device.deviceId}
                type="button"
                disabled={!isOnline}
                onClick={() => toggle(device.deviceId)}
                className={`flex items-center gap-3 rounded-md border p-2 text-left transition-colors ${
                  isSelected ? "border-primary bg-primary/5" : "hover:bg-accent/50"
                } ${isOnline ? "" : "cursor-not-allowed opacity-50"}`}
              >
                <span
                  className={`size-2 shrink-0 rounded-full ${
                    isOnline ? "bg-emerald-500" : "bg-muted-foreground/40"
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {device.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {device.osName ?? device.deviceId}
                  </span>
                </span>
                {isSelected && <CheckIcon className="size-4 text-primary" />}
              </button>
            )
          })}
        </div>
      )}

      {/* Terminal */}
      <div
        className="overflow-hidden rounded-lg border bg-zinc-950 shadow-xs"
        onMouseUp={() => {
          // Do not steal the caret when the user is selecting output to copy.
          if (!window.getSelection()?.toString()) inputRef.current?.focus()
        }}
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
          <span className="size-3 rounded-full bg-red-500/80" />
          <span className="size-3 rounded-full bg-yellow-500/80" />
          <span className="size-3 rounded-full bg-green-500/80" />
          <span className="ml-2 font-mono text-xs text-zinc-400">
            {broadcast
              ? `broadcast: ${broadcast.name} (${broadcast.deviceCount} devices)`
              : selected.length === 0
                ? "no target"
                : selected.map(nameOf).join(", ")}
          </span>
        </div>

        <div
          ref={scrollRef}
          className="h-[520px] overflow-y-auto p-4 font-mono text-[13px] leading-relaxed text-zinc-100"
        >
          {BANNER.map((line, i) => (
            <div key={`banner-${i}`} className="text-zinc-500">
              {line}
            </div>
          ))}
          <div className="mb-3" />

          {entries.map((entry) => (
            <div key={entry.id} className="mb-3">
              <div className="flex gap-2">
                <span className="shrink-0 text-emerald-400">
                  {prompt}
                  <span className="text-zinc-500">$</span>
                </span>
                <span className="min-w-0 break-all whitespace-pre-wrap">
                  {entry.command}
                </span>
              </div>

              {entry.error && (
                <div className="text-red-400">{entry.error}</div>
              )}

              {entry.skipped.map((s) => (
                <div key={s.deviceId} className="text-amber-400">
                  {nameOf(s.deviceId)}: skipped ({s.reason})
                </div>
              ))}

              {entry.targets.map((target) => {
                const run = runs[target.commandId]
                const text = run?.lines.map((l) => l.data).join("") ?? ""
                const failed =
                  run?.finished &&
                  (run.exitCode == null || run.exitCode !== 0)

                return (
                  <div key={target.commandId} className="mt-1">
                    {entry.targets.length > 1 && (
                      <div className="text-cyan-400">── {target.name}</div>
                    )}
                    {text && (
                      <pre className="whitespace-pre-wrap break-all text-zinc-100">
                        {text}
                      </pre>
                    )}
                    {run?.error && (
                      <div className="text-red-400">{run.error}</div>
                    )}
                    {!run?.finished ? (
                      <div className="text-zinc-500">
                        <span className="animate-pulse">▍</span> running…
                      </div>
                    ) : (
                      <div
                        className={failed ? "text-red-400" : "text-zinc-500"}
                      >
                        exit {run.exitCode ?? "?"}
                        {run.durationMs != null ? ` · ${run.durationMs}ms` : ""}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}

          {notes.map((line, i) => (
            <pre
              key={`note-${i}`}
              className="whitespace-pre-wrap break-all text-zinc-400"
            >
              {line}
            </pre>
          ))}

          {/* Live prompt */}
          <div className="flex gap-2">
            <label htmlFor="console-input" className="shrink-0 text-emerald-400">
              {prompt}
              <span className="text-zinc-500">$</span>
            </label>
            <input
              id="console-input"
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              readOnly={busy}
              disabled={!canExecute}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Console command input"
              className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-zinc-100 caret-emerald-400 outline-none placeholder:text-zinc-600 disabled:opacity-50"
              placeholder={
                !canExecute
                  ? "read-only: your role cannot run commands"
                  : busy
                    ? "dispatching…"
                    : ""
              }
            />
          </div>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        <kbd className="rounded border px-1">↑</kbd>{" "}
        <kbd className="rounded border px-1">↓</kbd> history ·{" "}
        <kbd className="rounded border px-1">Ctrl+L</kbd> clear ·{" "}
        <kbd className="rounded border px-1">help</kbd> for console commands
      </p>
    </div>
  )
}
