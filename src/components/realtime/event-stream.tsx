"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from "react";
import type { SseEvent } from "@/lib/protocol";

export interface CommandRun {
  commandId: string;
  deviceId: string;
  status: string;
  exitCode: number | null;
  lines: { seq: number; stream: "stdout" | "stderr"; data: string }[];
  durationMs: number | null;
  error: string | null;
  finished: boolean;
}

export interface DeviceMetrics {
  cpuPercent: number;
  memPercent: number;
  diskPercent: number;
  load1: number;
  uptimeSec: number;
  processes: number;
  recordedAt: string;
}

interface StreamState {
  status: Record<string, { status: "ONLINE" | "OFFLINE"; lastSeenAt: string | null }>;
  metrics: Record<string, DeviceMetrics>;
  runs: Record<string, CommandRun>;
  connected: boolean;
}

type Action =
  | { type: "event"; event: SseEvent }
  | { type: "connected"; value: boolean };

const initialState: StreamState = {
  status: {},
  metrics: {},
  runs: {},
  connected: false,
};

function reducer(state: StreamState, action: Action): StreamState {
  if (action.type === "connected") {
    return { ...state, connected: action.value };
  }

  const event = action.event;

  switch (event.type) {
    case "device.status":
      return {
        ...state,
        status: {
          ...state.status,
          [event.deviceId]: {
            status: event.status,
            lastSeenAt: event.lastSeenAt,
          },
        },
      };

    case "device.metrics":
      return {
        ...state,
        metrics: {
          ...state.metrics,
          [event.deviceId]: {
            cpuPercent: event.cpuPercent,
            memPercent: event.memPercent,
            diskPercent: event.diskPercent,
            load1: event.load1,
            uptimeSec: event.uptimeSec,
            processes: event.processes,
            recordedAt: event.recordedAt,
          },
        },
      };

    case "command.accepted": {
      const existing = state.runs[event.commandId];
      // SSE delivery is not ordered: a late "accepted" must never reopen a run
      // that already has its terminal result.
      if (existing?.finished) return state;
      return {
        ...state,
        runs: {
          ...state.runs,
          [event.commandId]: {
            commandId: event.commandId,
            deviceId: event.deviceId,
            status: event.status,
            exitCode: null,
            lines: existing?.lines ?? [],
            durationMs: null,
            error: null,
            finished: false,
          },
        },
      };
    }

    case "command.chunk": {
      const run = state.runs[event.commandId] ?? {
        commandId: event.commandId,
        deviceId: event.deviceId,
        status: "running",
        exitCode: null,
        lines: [],
        durationMs: null,
        error: null,
        finished: false,
      };
      // QoS 1 is at-least-once and replay can overlap live events, so
      // deduplicate on sequence number.
      if (run.lines.some((l) => l.seq === event.seq)) return state;
      const lines = [...run.lines, {
        seq: event.seq,
        stream: event.stream,
        data: event.data,
      }].sort((a, b) => a.seq - b.seq);
      return { ...state, runs: { ...state.runs, [event.commandId]: { ...run, lines } } };
    }

    case "command.result": {
      const run = state.runs[event.commandId];
      const lines = run?.lines ?? [];
      // If no chunks streamed, fall back to the final buffered output.
      const fallback =
        lines.length === 0 && (event.stdout || event.stderr)
          ? [
              ...(event.stdout
                ? [{ seq: 0, stream: "stdout" as const, data: event.stdout }]
                : []),
              ...(event.stderr
                ? [{ seq: 1, stream: "stderr" as const, data: event.stderr }]
                : []),
            ]
          : lines;

      return {
        ...state,
        runs: {
          ...state.runs,
          [event.commandId]: {
            commandId: event.commandId,
            deviceId: event.deviceId,
            status: event.status,
            exitCode: event.exitCode,
            lines: fallback,
            durationMs: event.durationMs,
            error: event.error,
            finished: true,
          },
        },
      };
    }

    default:
      return state;
  }
}

const StreamContext = createContext<StreamState>(initialState);

export function useEventStream() {
  return useContext(StreamContext);
}

export function EventStreamProvider({
  deviceIds,
  children,
}: {
  deviceIds: string[];
  children: React.ReactNode;
}) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const key = useMemo(() => [...deviceIds].sort().join(","), [deviceIds]);

  useEffect(() => {
    if (!key) return;

    const source = new EventSource(
      `/api/events?devices=${encodeURIComponent(key)}`,
    );

    const handler = (raw: MessageEvent) => {
      try {
        dispatch({ type: "event", event: JSON.parse(raw.data) as SseEvent });
      } catch {
        /* ignore malformed frame */
      }
    };

    for (const type of [
      "device.status",
      "device.metrics",
      "command.accepted",
      "command.chunk",
      "command.result",
    ]) {
      source.addEventListener(type, handler);
    }

    source.onopen = () => dispatch({ type: "connected", value: true });
    // EventSource reconnects on its own using the server's `retry:` hint.
    source.onerror = () => dispatch({ type: "connected", value: false });

    return () => source.close();
  }, [key]);

  return (
    <StreamContext.Provider value={state}>{children}</StreamContext.Provider>
  );
}
