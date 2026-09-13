import type { NextRequest } from "next/server";
import { z } from "zod";
import { env } from "@/server/config/env";
import { logger } from "@/server/infrastructure/logger/logger";
import {
  consumeEnrollmentToken,
  EnrollmentError,
} from "@/server/modules/tokens/token.service";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  clientIp,
  consumeRateLimit,
} from "@/server/infrastructure/ratelimit/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger.child({ module: "enroll-api" });

const enrollSchema = z.object({
  hostname: z.string().max(255).optional(),
  os: z
    .object({
      distro: z.string().max(128).optional(),
      version: z.string().max(128).optional(),
      kernel: z.string().max(128).optional(),
      arch: z.string().max(32).optional(),
      pretty: z.string().max(255).optional(),
    })
    .optional(),
  agent_version: z.string().max(64).optional(),
});

function bearer(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

/**
 * Exchanges a one-time enrollment token for per-device MQTT credentials.
 *
 * The enrollment token is deliberately NOT the MQTT password: it is
 * short-lived, single-use and human-visible (pasted into a terminal, stored in
 * shell history), whereas the MQTT credential is long-lived and machine-only.
 */
export async function POST(request: NextRequest) {
  // Unauthenticated endpoint: cap attempts per source so a leaked install
  // command cannot be replayed, and tokens cannot be probed in bulk.
  const ip = clientIp(request.headers);
  const wait = await consumeRateLimit(`enroll:${ip}`, 20, 10 * 60_000);
  if (wait > 0) {
    return Response.json(
      { error: "rate_limited", message: "Too many enrollment attempts" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(wait / 1000)) } },
    );
  }

  const token = bearer(request);
  if (!token) {
    return Response.json(
      { error: "missing_token", message: "Authorization: Bearer <token> required" },
      { status: 401 },
    );
  }

  let body: z.infer<typeof enrollSchema>;
  try {
    body = enrollSchema.parse(await request.json());
  } catch {
    return Response.json(
      { error: "invalid_body", message: "Malformed enrollment payload" },
      { status: 400 },
    );
  }

  try {
    const result = await consumeEnrollmentToken(token, {
      hostname: body.hostname,
      osName: body.os?.distro,
      osVersion: body.os?.version,
      kernel: body.os?.kernel,
      arch: body.os?.arch,
      agentVersion: body.agent_version,
    });

    let caPem: string | null = null;
    if (env.MQTT_CA_FILE) {
      try {
        caPem = readFileSync(
          resolve(/* turbopackIgnore: true */ process.cwd(), env.MQTT_CA_FILE),
          "utf8",
        );
      } catch {
        log.warn("CA file unreadable; agent will use the system trust store");
      }
    }

    return Response.json({
      device_id: result.deviceId,
      mqtt: {
        host: env.AGENT_MQTT_HOST,
        port: env.AGENT_MQTT_PORT,
        username: result.mqttUsername,
        password: result.mqttPassword,
      },
      ca_pem: caPem,
      groups: result.groupId ? [result.groupId] : [],
    });
  } catch (err) {
    if (err instanceof EnrollmentError) {
      return Response.json(
        { error: err.code, message: err.message },
        { status: err.status },
      );
    }
    log.error("enrollment failed", { error: String(err) });
    return Response.json(
      { error: "internal", message: "Enrollment failed" },
      { status: 500 },
    );
  }
}
