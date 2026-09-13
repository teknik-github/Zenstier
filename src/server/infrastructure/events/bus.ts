import "server-only";
import Redis from "ioredis";
import { EventEmitter } from "node:events";
import { env } from "@/server/config/env";
import { logger } from "@/server/infrastructure/logger/logger";
import type { SseEvent } from "@/lib/protocol";

const log = logger.child({ module: "bus" });

export const deviceChannel = (deviceId: string) => `zenstier:dev:${deviceId}`;
export const CONTROL_CHANNEL = "zenstier:control";

interface BusCore {
  sub: Redis;
  pub: Redis;
  local: EventEmitter;
  refs: Map<string, number>;
}

const globalForBus = globalThis as unknown as { __zenstierBus?: BusCore };

function core(): BusCore {
  if (globalForBus.__zenstierBus) return globalForBus.__zenstierBus;

  const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const pub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const local = new EventEmitter();
  // One listener per open SSE stream; the default cap of 10 would warn.
  local.setMaxListeners(0);
  const refs = new Map<string, number>();

  sub.on("message", (channel, raw) => {
    try {
      local.emit(channel, JSON.parse(raw) as SseEvent);
    } catch (err) {
      log.error("undecodable bus message", { channel, error: String(err) });
    }
  });

  // ioredis resubscribes automatically, but re-assert to be certain.
  sub.on("ready", () => {
    const channels = [...refs.keys()];
    if (channels.length) void sub.subscribe(...channels);
  });

  sub.on("error", (err) => log.error("redis sub error", { error: String(err) }));
  pub.on("error", (err) => log.error("redis pub error", { error: String(err) }));

  const created: BusCore = { sub, pub, local, refs };
  globalForBus.__zenstierBus = created;
  return created;
}

/**
 * Subscribes to one or more device channels.
 *
 * A Redis connection in subscriber mode can do nothing else, so the process
 * keeps exactly ONE subscriber connection and demultiplexes locally with
 * reference counting. Returns an unsubscribe function.
 */
export function subscribe(
  channels: string[],
  onEvent: (event: SseEvent) => void,
): () => void {
  const { sub, local, refs } = core();
  const fresh: string[] = [];

  for (const channel of channels) {
    const next = (refs.get(channel) ?? 0) + 1;
    refs.set(channel, next);
    if (next === 1) fresh.push(channel);
    local.on(channel, onEvent);
  }

  if (fresh.length) void sub.subscribe(...fresh);

  return () => {
    const gone: string[] = [];
    for (const channel of channels) {
      local.off(channel, onEvent);
      const next = (refs.get(channel) ?? 1) - 1;
      if (next <= 0) {
        refs.delete(channel);
        gone.push(channel);
      } else {
        refs.set(channel, next);
      }
    }
    if (gone.length) void sub.unsubscribe(...gone);
  };
}

export async function publish(
  channel: string,
  event: SseEvent,
): Promise<void> {
  await core().pub.publish(channel, JSON.stringify(event));
}

/** Shared Redis connection for non-pubsub use (rate limiting). */
export function redis(): Redis {
  return core().pub;
}
