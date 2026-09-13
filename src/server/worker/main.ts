/**
 * Zenstier MQTT ingest worker.
 *
 * Runs as a SEPARATE process from the Next.js server, deliberately:
 *
 *  - It is the single writer of inbound facts (device presence, command
 *    output, terminal command status). Running it inside Next would mean one
 *    subscription per server instance, and every instance racing to write the
 *    same rows.
 *  - Next dev's HMR would otherwise accumulate broker connections, and
 *    `instrumentation.ts` also executes in build/prerender workers.
 *
 * Fan-out to browsers goes through Redis pub/sub, which the SSE route handlers
 * subscribe to.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import mqtt, { type MqttClient } from "mqtt";
import { env } from "@/server/config/env";
import { logger } from "@/server/infrastructure/logger/logger";
import { prisma } from "@/server/infrastructure/db/prisma";
import { DeviceStatus, CommandStatus } from "@/generated/prisma/enums";
import { deviceIdFromTopic, topics } from "@/lib/protocol";
import { publish, deviceChannel } from "@/server/infrastructure/events/bus";
import { handleResult, handleStatus } from "./handlers";

const log = logger.child({ module: "worker" });

const SYS_UPTIME = "$SYS/broker/uptime";
/** Suppression window after a broker restart, ~3x keepalive + slack. */
const GRACE_WINDOW_MS = 120_000;
const STALE_AFTER_MS = 180_000;
const REAPER_INTERVAL_MS = 15_000;

let graceUntil = 0;
let client: MqttClient | null = null;

function caOption() {
  if (!env.MQTT_CA_FILE) return {};
  try {
    return {
      ca: [readFileSync(resolve(/* turbopackIgnore: true */ process.cwd(), env.MQTT_CA_FILE))],
      rejectUnauthorized: true,
    };
  } catch (err) {
    log.warn("CA file unreadable, falling back to system trust", {
      error: String(err),
    });
    return {};
  }
}

async function onMessage(topic: string, payload: Buffer) {
  try {
    if (topic === SYS_UPTIME) {
      const seconds = parseInt(payload.toString(), 10);
      // A freshly restarted broker means every agent is about to reconnect at
      // once. Suppress offline transitions so a restart doesn't look like a
      // fleet-wide outage.
      if (Number.isFinite(seconds) && seconds < 120) {
        graceUntil = Date.now() + GRACE_WINDOW_MS;
        log.warn("broker restart detected, entering grace window", { seconds });
      }
      return;
    }

    const deviceId = deviceIdFromTopic(topic);
    if (!deviceId) return;

    if (topic.endsWith("/status")) await handleStatus(deviceId, payload);
    else if (topic.endsWith("/result")) await handleResult(deviceId, payload);
  } catch (err) {
    log.error("message handler failed", { topic, error: String(err) });
  }
}

/**
 * Backstop for presence and command lifetimes.
 *
 * LWT gives fast detection (~45s) but is lost if the broker restarts or
 * persistence is off; `lastSeenAt` is the ground truth.
 */
async function reap() {
  if (Date.now() < graceUntil) return;
  if (!client?.connected) return; // We are blind, not informed.

  const staleBefore = new Date(Date.now() - STALE_AFTER_MS);
  const stale = await prisma.device.findMany({
    where: {
      status: DeviceStatus.ONLINE,
      OR: [{ lastSeenAt: { lt: staleBefore } }, { lastSeenAt: null }],
    },
    select: { deviceId: true },
  });

  for (const device of stale) {
    await prisma.device.update({
      where: { deviceId: device.deviceId },
      data: { status: DeviceStatus.OFFLINE },
    });
    await publish(deviceChannel(device.deviceId), {
      type: "device.status",
      deviceId: device.deviceId,
      status: "OFFLINE",
      lastSeenAt: null,
    });
    log.info("device marked offline by reaper", { deviceId: device.deviceId });
  }

  // Fail commands whose agent never reported back.
  const overdue = await prisma.command.findMany({
    where: {
      status: { in: [CommandStatus.DISPATCHED, CommandStatus.RUNNING] },
      dispatchedAt: { not: null },
    },
    select: { id: true, timeoutMs: true, dispatchedAt: true, device: { select: { deviceId: true } } },
    take: 200,
  });

  const now = Date.now();
  for (const cmd of overdue) {
    const deadline =
      (cmd.dispatchedAt?.getTime() ?? now) + cmd.timeoutMs + 30_000;
    if (now < deadline) continue;

    await prisma.command.update({
      where: { id: cmd.id },
      data: {
        status: CommandStatus.TIMEOUT,
        finishedAt: new Date(),
        error: "No response from agent before timeout",
      },
    });
    await publish(deviceChannel(cmd.device.deviceId), {
      type: "command.result",
      commandId: cmd.id,
      deviceId: cmd.device.deviceId,
      status: CommandStatus.TIMEOUT,
      exitCode: null,
      stdout: "",
      stderr: "",
      truncated: false,
      durationMs: null,
      error: "No response from agent before timeout",
    });
  }
}

async function main() {
  log.info("starting MQTT ingest worker", { broker: env.MQTT_URL });

  client = mqtt.connect(env.MQTT_URL, {
    // A STABLE client id is deliberate: MQTT brokers evict an existing session
    // when a new client connects with the same id, so starting a second worker
    // kicks the first instead of both writing the same rows. Override
    // ZENSTIER_WORKER_ID only when intentionally sharding.
    clientId: process.env.ZENSTIER_WORKER_ID ?? "zenstier-worker",
    username: env.MQTT_BACKEND_USERNAME,
    password: env.MQTT_BACKEND_PASSWORD,
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 2_000,
    connectTimeout: 10_000,
    ...caOption(),
  });

  client.on("connect", () => {
    log.info("worker connected to broker");
    // Retained status messages arrive immediately, giving a full fleet
    // snapshot with no polling.
    client!.subscribe(
      [topics.allResults, topics.allStatus, SYS_UPTIME],
      { qos: 1 },
      (err, granted) => {
        if (err) return log.error("subscribe failed", { error: String(err) });
        const denied = (granted ?? []).filter((g) => g.qos === 128);
        if (denied.length) {
          log.error("subscriptions denied by broker ACL", {
            topics: denied.map((d) => d.topic),
          });
        }
        log.info("worker subscribed", {
          topics: (granted ?? []).map((g) => g.topic),
        });
      },
    );
  });

  client.on("message", (topic, payload) => void onMessage(topic, payload));
  client.on("error", (err) => log.error("worker mqtt error", { error: String(err) }));
  client.on("close", () => log.warn("worker connection closed"));
  client.on("reconnect", () => log.info("worker reconnecting"));

  const reaper = setInterval(() => void reap().catch((err) =>
    log.error("reaper failed", { error: String(err) }),
  ), REAPER_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    clearInterval(reaper);
    try {
      await client?.endAsync();
      await prisma.$disconnect();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("worker failed to start", { error: String(err) });
  process.exit(1);
});
