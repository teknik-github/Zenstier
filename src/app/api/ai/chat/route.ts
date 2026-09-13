import type { NextRequest } from "next/server";
import { z } from "zod";
import { AuditAction } from "@/generated/prisma/enums";
import { prisma } from "@/server/infrastructure/db/prisma";
import { env } from "@/server/config/env";
import { logger } from "@/server/infrastructure/logger/logger";
import { getTeamContext } from "@/server/modules/teams/context";
import { consumeRateLimit } from "@/server/infrastructure/ratelimit/ratelimit";
import { AiError, streamChat } from "@/server/modules/ai/ai.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const log = logger.child({ module: "ai-api" });

const bodySchema = z.object({
  deviceIds: z.array(z.string().min(1)).max(100).default([]),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000),
      }),
    )
    .min(1)
    .max(40),
});

export async function POST(request: NextRequest) {
  // Route handlers are reachable directly and the proxy excludes /api, so the
  // permission check has to happen here.
  let ctx;
  try {
    ctx = await getTeamContext();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!ctx.can("ai:use")) {
    return new Response("Forbidden", { status: 403 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return new Response("Invalid request", { status: 400 });
  }

  // Model calls cost money and time; cap them per user.
  const wait = await consumeRateLimit(
    `ai:${ctx.user.id}`,
    env.AI_RATE_LIMIT_PER_HOUR,
    60 * 60_000,
  );
  if (wait > 0) {
    return new Response("Too many AI requests", {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(wait / 1000)) },
    });
  }

  // Devices are re-resolved against the team: an id from the request body is
  // never trusted to scope what the assistant can see.
  const owned = await prisma.device.findMany({
    where: { teamId: ctx.team.id, deviceId: { in: body.deviceIds } },
    select: { deviceId: true },
  });
  const deviceIds = owned.map((d) => d.deviceId);

  const prompt = body.messages.at(-1)?.content ?? "";
  await prisma.auditLog.create({
    data: {
      userId: ctx.user.id,
      teamId: ctx.team.id,
      action: AuditAction.AI_CONSULTED,
      targetType: "ai",
      targetId: null,
      metadata: {
        model: env.AI_MODEL,
        prompt: prompt.slice(0, 500),
        devices: deviceIds,
      },
    },
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          return false; // client went away
        }
      };

      try {
        for await (const delta of streamChat(
          ctx.team.id,
          deviceIds,
          body.messages,
          request.signal,
        )) {
          if (!send(delta)) break;
        }
      } catch (err) {
        const message =
          err instanceof AiError ? err.message : "The assistant failed.";
        if (!(err instanceof AiError)) {
          log.error("ai stream failed", { error: String(err) });
        }
        send(`\n\n**${message}**`);
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "Content-Encoding": "identity",
    },
  });
}
