import "server-only";
import mqtt, { type MqttClient } from "mqtt";
import { env } from "@/server/config/env";
import { logger } from "@/server/infrastructure/logger/logger";
import { readCaFile } from "./dynsec";

const log = logger.child({ module: "mqtt-publisher" });

/**
 * Publish-only MQTT client used by the web process to dispatch commands.
 *
 * It never subscribes, so a duplicate created by dev HMR costs one idle TCP
 * connection and nothing more. Command publishes are keyed by a deterministic
 * command id and are therefore idempotent.
 */
const globalForPublisher = globalThis as unknown as {
  __zenstierPublisher?: MqttClient;
};

function client(): MqttClient {
  if (globalForPublisher.__zenstierPublisher) {
    return globalForPublisher.__zenstierPublisher;
  }

  const ca = readCaFile();
  const created = mqtt.connect(env.MQTT_URL, {
    clientId: `zenstier-web-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
    username: env.MQTT_BACKEND_USERNAME,
    password: env.MQTT_BACKEND_PASSWORD,
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 2_000,
    connectTimeout: 10_000,
    ...(ca ? { ca: [ca], rejectUnauthorized: true } : {}),
  });

  created.on("error", (err) =>
    log.error("publisher error", { error: String(err) }),
  );
  created.on("connect", () => log.info("command publisher connected"));

  globalForPublisher.__zenstierPublisher = created;
  return created;
}

export function publishCommand(topic: string, payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    client().publish(
      topic,
      JSON.stringify(payload),
      { qos: 1, retain: false },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

/** Clears a retained status message when a device is deleted. */
export function clearRetainedStatus(topic: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client().publish(topic, "", { qos: 1, retain: true }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}
