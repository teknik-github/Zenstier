"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { runCommandAction } from "@/app/_actions/commands";
import { useEventStream } from "@/components/realtime/event-stream";
import type { DeviceRow } from "@/components/devices/device-manager";
import { ChevronDownIcon, CheckIcon, TrashIcon } from "lucide-react";

/**
 * Reads a text stream, handing back the text accumulated so far.
 *
 * Module scope on purpose: the React Compiler treats values captured inside a
 * component as immutable, so the accumulator cannot live in the handler.
 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (text: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(decoder.decode(value, { stream: true }));
    onProgress(parts.join(""));
  }
}

/** Flags commands worth a second look before running them as root. */
function riskOf(command: string): string | null {
  const patterns: [RegExp, string][] = [
    [/\brm\s+-[a-z]*[rf]/, "deletes files recursively"],
    [/\b(reboot|shutdown|halt|poweroff)\b/, "restarts or powers off the host"],
    [/\bmkfs|dd\s+if=|>\s*\/dev\/[sn][dv]/, "writes directly to a disk"],
    [/\b(userdel|passwd|chpasswd)\b/, "changes user accounts"],
    [/\b(iptables|nft|ufw)\b.*\b(flush|-F|reset)\b/, "clears firewall rules"],
    [/\bcurl\b[^|]*\|\s*(ba)?sh|\bwget\b[^|]*\|\s*(ba)?sh/, "pipes a download into a shell"],
    [/\bsystemctl\s+(stop|disable|mask)\b/, "stops or disables a service"],
    [/:\(\)\s*\{.*\};:/, "looks like a fork bomb"],
  ];
  for (const [re, why] of patterns) if (re.test(command)) return why;
  return null;
}

/** Splits a reply into prose and runnable command blocks. */
function segments(markdown: string) {
  const out: { kind: "text" | "command"; value: string }[] = [];
  const fence = /```(?:sh|bash|shell)\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(markdown)) !== null) {
    if (m.index > last) {
      out.push({ kind: "text", value: markdown.slice(last, m.index) });
    }
    out.push({ kind: "command", value: (m[1] ?? "").trim() });
    last = m.index + m[0].length;
  }
  if (last < markdown.length) {
    out.push({ kind: "text", value: markdown.slice(last) });
  }
  return out;
}

interface RunRecord {
  commandId: string;
  deviceId: string;
  name: string;
}

interface Entry {
  id: number;
  kind: "prompt" | "reply" | "note" | "run";
  text: string;
  /** reply: proposal number assigned to each command block, in order. */
  proposalIds?: number[];
  /** run: which proposal was executed. */
  proposal?: number;
  command?: string;
  runs?: RunRecord[];
  error?: string;
}

const BANNER = [
  "Zenstier AI console",
  "The assistant drafts commands; it never runs them. You approve each one.",
  "Type a question, or `help` for console commands.",
];

const HELP = [
  "  help                 show this message",
  "  clear                clear the scrollback",
  "  targets              list selected devices",
  "  use <name|id>        select a single device",
  "  use all              select every online device",
  "  use none             clear the selection",
  "  run <n>              run proposal [n] on the selected devices",
  "",
  "  Up / Down            browse history",
  "  Ctrl+L               clear the scrollback",
  "  anything else        is asked of the assistant",
];

export function AiConsole({
  devices,
  canExecute,
  configured,
}: {
  devices: DeviceRow[];
  canExecute: boolean;
  configured: boolean;
}) {
  const { status: liveStatus, runs: liveRuns } = useEventStream();
  const [chosen, setChosen] = React.useState<string[] | null>(null);
  const [entries, setEntries] = React.useState<Entry[]>([]);
  const [input, setInput] = React.useState("");
  const [history, setHistory] = React.useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = React.useState(-1);
  const [busy, setBusy] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);

  const nextId = React.useRef(1);
  const nextProposal = React.useRef(1);
  // Proposal number -> command text, so `run 2` resolves without scanning.
  const proposals = React.useRef(new Map<number, string>());
  const inputRef = React.useRef<HTMLInputElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const statusOf = React.useCallback(
    (d: DeviceRow) => liveStatus[d.deviceId]?.status ?? d.status,
    [liveStatus],
  );
  const online = React.useMemo(
    () => devices.filter((d) => statusOf(d) === "ONLINE"),
    [devices, statusOf],
  );
  const selected = React.useMemo(
    () => chosen ?? (online.length === 1 ? [online[0]!.deviceId] : []),
    [chosen, online],
  );
  const setSelected = React.useCallback(
    (next: string[] | ((prev: string[]) => string[])) => {
      setChosen((prev) => {
        const current = prev ?? (online.length === 1 ? [online[0]!.deviceId] : []);
        return typeof next === "function" ? next(current) : next;
      });
    },
    [online],
  );

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, liveRuns]);

  const nameOf = React.useCallback(
    (deviceId: string) =>
      devices.find((d) => d.deviceId === deviceId)?.name ?? deviceId,
    [devices],
  );

  const push = (entry: Omit<Entry, "id">) =>
    setEntries((prev) => [...prev, { id: nextId.current++, ...entry }]);

  const note = (text: string) => push({ kind: "note", text });

  async function runProposal(n: number) {
    const command = proposals.current.get(n);
    if (!command) {
      note(`  no proposal [${n}]`);
      return;
    }
    if (!canExecute) {
      note("  permission denied: your role cannot run commands");
      return;
    }
    if (selected.length === 0) {
      note("  no target selected — use `use <name>` or the Targets picker");
      return;
    }

    const entryId = nextId.current++;
    setEntries((prev) => [
      ...prev,
      { id: entryId, kind: "run", text: "", proposal: n, command },
    ]);

    const result = await runCommandAction(command, selected);
    setEntries((prev) =>
      prev.map((e) =>
        e.id === entryId
          ? {
              ...e,
              error: result.error,
              runs: result.dispatched.map((d) => ({
                commandId: d.commandId,
                deviceId: d.deviceId,
                name: nameOf(d.deviceId),
              })),
            }
          : e,
      ),
    );
  }

  async function ask(question: string) {
    const priorTurns = entries
      .filter((e) => e.kind === "prompt" || e.kind === "reply")
      .map((e) => ({
        role: e.kind === "prompt" ? ("user" as const) : ("assistant" as const),
        content: e.text,
      }))
      .filter((m) => m.content.trim());

    push({ kind: "prompt", text: question });
    const replyId = nextId.current++;
    setEntries((prev) => [...prev, { id: replyId, kind: "reply", text: "" }]);
    setBusy(true);

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceIds: selected,
          messages: [...priorTurns, { role: "user", content: question }],
        }),
      });

      if (!res.ok || !res.body) {
        const detail =
          res.status === 403
            ? "your role does not allow using the assistant"
            : res.status === 429
              ? "too many AI requests — try again shortly"
              : `the assistant is unavailable (${res.status})`;
        setEntries((prev) =>
          prev.map((e) => (e.id === replyId ? { ...e, error: detail } : e)),
        );
        return;
      }

      await readStream(res.body, (text) => {
        setEntries((prev) =>
          prev.map((e) => (e.id === replyId ? { ...e, text } : e)),
        );
      });

      // Number the proposals once the reply is complete.
      setEntries((prev) =>
        prev.map((e) => {
          if (e.id !== replyId) return e;
          const ids = segments(e.text)
            .filter((seg) => seg.kind === "command")
            .map((seg) => {
              const n = nextProposal.current++;
              proposals.current.set(n, seg.value);
              return n;
            });
          return { ...e, proposalIds: ids };
        }),
      );
    } catch {
      setEntries((prev) =>
        prev.map((e) =>
          e.id === replyId ? { ...e, error: "lost connection to the assistant" } : e,
        ),
      );
    } finally {
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  async function submit(raw: string) {
    const line = raw.trim();
    if (!line) return;
    setHistory((prev) => [...prev, line]);
    setHistoryIndex(-1);
    setInput("");

    const [verb, ...args] = line.split(/\s+/);
    switch (verb) {
      case "help":
        push({ kind: "prompt", text: line });
        note(HELP.join("\n"));
        return;
      case "clear":
        setEntries([]);
        return;
      case "targets":
        push({ kind: "prompt", text: line });
        note(
          selected.length
            ? selected.map((d) => `  ${nameOf(d)}  (${d})`).join("\n")
            : "  no devices selected",
        );
        return;
      case "run": {
        push({ kind: "prompt", text: line });
        const n = Number(args[0]);
        if (!Number.isInteger(n)) {
          note("  usage: run <proposal number>");
          return;
        }
        await runProposal(n);
        return;
      }
      case "use": {
        push({ kind: "prompt", text: line });
        const arg = args.join(" ");
        if (arg === "all") {
          setSelected(online.map((d) => d.deviceId));
          note(`  selected ${online.length} online device(s)`);
          return;
        }
        if (arg === "none") {
          setSelected([]);
          note("  cleared the selection");
          return;
        }
        const match = devices.find(
          (d) => d.deviceId === arg || d.name.toLowerCase() === arg.toLowerCase(),
        );
        if (!match) {
          note(`  no device matching "${arg}"`);
          return;
        }
        setSelected([match.deviceId]);
        note(`  selected ${match.name}`);
        return;
      }
    }

    await ask(line);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (busy) return;
      void submit(input);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!history.length) return;
      const next = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setInput(history[next] ?? "");
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex < 0) return;
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(-1);
        setInput("");
      } else {
        setHistoryIndex(next);
        setInput(history[next] ?? "");
      }
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      setEntries([]);
    }
  }

  const prompt =
    selected.length === 0
      ? "ai"
      : selected.length === 1
        ? `ai:${nameOf(selected[0]!)}`
        : `ai:${selected.length} devices`;

  if (!configured) {
    return (
      <div className="overflow-hidden rounded-lg border bg-zinc-950 shadow-xs">
        <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
          <span className="size-3 rounded-full bg-red-500/80" />
          <span className="size-3 rounded-full bg-yellow-500/80" />
          <span className="size-3 rounded-full bg-green-500/80" />
          <span className="ml-2 font-mono text-xs text-zinc-400">not configured</span>
        </div>
        <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed text-zinc-300">
{`No AI provider is configured.

Add to .env and restart — any OpenAI-compatible endpoint works:

  AI_BASE_URL=https://api.deepseek.com
  AI_API_KEY=sk-...
  AI_MODEL=deepseek-chat

  # or OpenAI:  https://api.openai.com     gpt-4o-mini
  # or Ollama:  http://localhost:11434     llama3.1`}
        </pre>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setPickerOpen((v) => !v)}>
          Targets
          <Badge variant="secondary">{selected.length}</Badge>
          <ChevronDownIcon className={pickerOpen ? "rotate-180 transition-transform" : "transition-transform"} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSelected(online.map((d) => d.deviceId))}
        >
          Select all online ({online.length})
        </Button>
        {selected.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
            Clear
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => setEntries([])}
        >
          <TrashIcon />
          <span className="hidden sm:inline">Clear output</span>
        </Button>
      </div>

      {pickerOpen && (
        <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-3">
          {devices.map((device) => {
            const isOnline = statusOf(device) === "ONLINE";
            const isSelected = selected.includes(device.deviceId);
            return (
              <button
                key={device.deviceId}
                type="button"
                disabled={!isOnline}
                onClick={() =>
                  setSelected((prev) =>
                    prev.includes(device.deviceId)
                      ? prev.filter((d) => d !== device.deviceId)
                      : [...prev, device.deviceId],
                  )
                }
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
                  <span className="block truncate text-sm font-medium">{device.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {device.osName ?? device.deviceId}
                  </span>
                </span>
                {isSelected && <CheckIcon className="size-4 text-primary" />}
              </button>
            );
          })}
        </div>
      )}

      <div
        className="overflow-hidden rounded-lg border bg-zinc-950 shadow-xs"
        onMouseUp={() => {
          if (!window.getSelection()?.toString()) inputRef.current?.focus();
        }}
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
          <span className="size-3 rounded-full bg-red-500/80" />
          <span className="size-3 rounded-full bg-yellow-500/80" />
          <span className="size-3 rounded-full bg-green-500/80" />
          <span className="ml-2 font-mono text-xs text-zinc-400">
            assistant · {selected.length === 0 ? "no target" : selected.map(nameOf).join(", ")}
          </span>
        </div>

        <div
          ref={scrollRef}
          className="h-[560px] overflow-y-auto p-4 font-mono text-[13px] leading-relaxed text-zinc-100"
        >
          {BANNER.map((line, i) => (
            <div key={`b${i}`} className="text-zinc-500">{line}</div>
          ))}
          <div className="mb-3" />

          {entries.map((entry) => {
            if (entry.kind === "prompt") {
              return (
                <div key={entry.id} className="mt-3 flex gap-2">
                  <span className="shrink-0 text-cyan-400">
                    {prompt}
                    <span className="text-zinc-500">&gt;</span>
                  </span>
                  <span className="min-w-0 break-all whitespace-pre-wrap">{entry.text}</span>
                </div>
              );
            }

            if (entry.kind === "note") {
              return (
                <pre key={entry.id} className="whitespace-pre-wrap break-all text-zinc-400">
                  {entry.text}
                </pre>
              );
            }

            if (entry.kind === "run") {
              return (
                <div key={entry.id} className="mt-1">
                  {entry.error && <div className="text-red-400">{entry.error}</div>}
                  {entry.runs?.map((r) => {
                    const live = liveRuns[r.commandId];
                    const text = live?.lines.map((l) => l.data).join("") ?? "";
                    const failed =
                      live?.finished && (live.exitCode == null || live.exitCode !== 0);
                    return (
                      <div key={r.commandId} className="mt-1">
                        <div className="text-cyan-400">── {r.name}</div>
                        {text && (
                          <pre className="whitespace-pre-wrap break-all text-zinc-100">{text}</pre>
                        )}
                        {live?.finished ? (
                          <div className={failed ? "text-red-400" : "text-zinc-500"}>
                            exit {live.exitCode ?? "?"}
                            {live.durationMs != null ? ` · ${live.durationMs}ms` : ""}
                          </div>
                        ) : (
                          <div className="text-zinc-500">
                            <span className="animate-pulse">▍</span> running…
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!entry.runs && !entry.error && (
                    <div className="text-zinc-500">
                      <span className="animate-pulse">▍</span> dispatching…
                    </div>
                  )}
                </div>
              );
            }

            // reply
            let cmdSeen = -1;
            return (
              <div key={entry.id} className="mt-1">
                {entry.error && <div className="text-red-400">error: {entry.error}</div>}
                {!entry.text && !entry.error && (
                  <div className="text-zinc-500">
                    <span className="animate-pulse">▍</span> thinking…
                  </div>
                )}
                {segments(entry.text).map((seg, i) => {
                  if (seg.kind === "text") {
                    return (
                      <pre key={i} className="whitespace-pre-wrap break-words text-zinc-200">
                        {seg.value.replace(/\n{3,}/g, "\n\n")}
                      </pre>
                    );
                  }
                  cmdSeen += 1;
                  const number = entry.proposalIds?.[cmdSeen];
                  const risk = riskOf(seg.value);
                  return (
                    <div key={i} className="my-2 border-l-2 border-zinc-700 pl-3">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="shrink-0 text-amber-400">
                          {number ? `[${number}]` : "[…]"}
                        </span>
                        <code className="min-w-0 break-all whitespace-pre-wrap text-emerald-300">
                          {seg.value}
                        </code>
                      </div>
                      {risk && (
                        <div className="mt-1 text-amber-500">! this {risk} — read it before running</div>
                      )}
                      {number && (
                        <div className="mt-1 flex items-center gap-3">
                          <button
                            type="button"
                            disabled={!canExecute || selected.length === 0}
                            onClick={() => void runProposal(number)}
                            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            ▷ run {number}
                          </button>
                          <span className="text-xs text-zinc-600">
                            or type <span className="text-zinc-400">run {number}</span>
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}

          <div className="mt-3 flex gap-2">
            <label htmlFor="ai-input" className="shrink-0 text-cyan-400">
              {prompt}
              <span className="text-zinc-500">&gt;</span>
            </label>
            <input
              id="ai-input"
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              readOnly={busy}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Ask the assistant"
              className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-zinc-100 caret-cyan-400 outline-none placeholder:text-zinc-600"
              placeholder={busy ? "thinking…" : ""}
            />
          </div>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        <kbd className="rounded border px-1">↑</kbd> <kbd className="rounded border px-1">↓</kbd> history ·{" "}
        <kbd className="rounded border px-1">run n</kbd> approve a proposal ·{" "}
        <kbd className="rounded border px-1">help</kbd> for console commands. Device
        output is fed back as context and always treated as untrusted data.
      </p>
    </div>
  );
}
