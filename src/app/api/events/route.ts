import type { NextRequest } from "next/server";
import { prisma } from "@/server/infrastructure/db/prisma";
import { getTeamContext } from "@/server/modules/teams/context";
import { subscribe, deviceChannel } from "@/server/infrastructure/events/bus";
import type { SseEvent } from "@/lib/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;
/** Recycle the connection so a leaked stream self-heals; the client reconnects. */
const MAX_LIFETIME_MS = 10 * 60_000;
const MAX_REPLAY_BUFFER = 512;

export async function GET(request: NextRequest) {
  // Route handlers are reachable directly and the proxy excludes /api, so both
  // authentication and authorisation must happen here.
  let ctx;
  try {
    ctx = await getTeamContext();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!ctx.can("device:read")) {
    return new Response("Forbidden", { status: 403 });
  }

  const requested = (request.nextUrl.searchParams.get("devices") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 200);

  // Never trust device ids from the query string.
  const owned = await prisma.device.findMany({
    where: {
      teamId: ctx.team.id,
      ...(requested.length ? { deviceId: { in: requested } } : {}),
    },
    select: { id: true, deviceId: true, status: true, lastSeenAt: true },
  });

  if (owned.length === 0) {
    return new Response("No accessible devices", { status: 403 });
  }

  const publicIds = owned.map((d) => d.deviceId);
  const internalIds = owned.map((d) => d.id);

  const lastEventId = request.headers.get("last-event-id");
  const cursor =
    lastEventId && lastEventId.startsWith("o")
      ? BigInt(lastEventId.slice(1))
      : null;

  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        if (lifetime) clearTimeout(lifetime);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Enqueuing to a closed controller throws; this is the primary
          // disconnect signal, with request.signal as the backup.
          cleanup();
        }
      };

      const send = (event: SseEvent, id?: string) =>
        write(
          `${id ? `id: ${id}\n` : ""}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );

      write("retry: 3000\n\n");

      // Subscribe BEFORE replaying so nothing is lost in the gap between the
      // replay query and going live.
      let replaying = true;
      const pending: SseEvent[] = [];
      unsubscribe = subscribe(publicIds.map(deviceChannel), (event) => {
        if (!replaying) return send(event);
        if (pending.length >= MAX_REPLAY_BUFFER) return;
        pending.push(event);
      });

      try {
        if (cursor !== null) {
          const missed = await prisma.commandOutput.findMany({
            where: { deviceId: { in: internalIds }, id: { gt: cursor } },
            orderBy: { id: "asc" },
            take: 2000,
            include: { device: { select: { deviceId: true } } },
          });
          for (const row of missed) {
            send(
              {
                type: "command.chunk",
                commandId: row.commandId,
                deviceId: row.device.deviceId,
                stream: row.stream === "STDERR" ? "stderr" : "stdout",
                seq: row.seq,
                data: row.chunk,
              },
              `o${row.id}`,
            );
          }
        }

        // Device status is idempotent: always send a fresh snapshot rather
        // than replaying individual transitions.
        for (const device of owned) {
          send({
            type: "device.status",
            deviceId: device.deviceId,
            status: device.status === "ONLINE" ? "ONLINE" : "OFFLINE",
            lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
          });
        }
      } catch {
        cleanup();
        return;
      }

      replaying = false;
      for (const event of pending) send(event);
      pending.length = 0;

      // Comment frames keep proxies from timing the connection out without
      // firing onmessage in the browser.
      heartbeat = setInterval(() => write(`: ka ${Date.now()}\n\n`), HEARTBEAT_MS);
      lifetime = setTimeout(cleanup, MAX_LIFETIME_MS);
      request.signal.addEventListener("abort", cleanup);
    },

    cancel() {
      closed = true;
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
      if (lifetime) clearTimeout(lifetime);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Defeat nginx response buffering.
      "X-Accel-Buffering": "no",
      "Content-Encoding": "identity",
    },
  });
}
