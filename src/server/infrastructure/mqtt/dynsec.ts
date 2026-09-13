import "server-only";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import mqtt, { type MqttClient } from "mqtt";
import { env } from "@/server/config/env";
import { logger } from "@/server/infrastructure/logger/logger";

const log = logger.child({ module: "dynsec" });

const CONTROL_TOPIC = "$CONTROL/dynamic-security/v1";
const RESPONSE_TOPIC = "$CONTROL/dynamic-security/v1/response";
const REQUEST_TIMEOUT_MS = 5_000;

export type DynsecCommand = Record<string, unknown> & { command: string };

interface DynsecResponse {
  command: string;
  error?: string;
  data?: unknown;
}

export function readCaFile(): Buffer | undefined {
  if (!env.MQTT_CA_FILE) return undefined;
  try {
    // Runtime-configured path; Turbopack cannot trace it statically.
    return readFileSync(resolve(/* turbopackIgnore: true */ process.cwd(), env.MQTT_CA_FILE));
  } catch (err) {
    log.warn("could not read MQTT CA file", {
      path: env.MQTT_CA_FILE,
      error: String(err),
    });
    return undefined;
  }
}

/**
 * Mosquitto dynamic-security control client.
 *
 * Responses arrive on a single shared topic at QoS 0 and carry NO correlation
 * id — they are matched positionally, in request order. Command batches are
 * therefore serialised behind a promise chain so only one is ever in flight.
 */
class DynsecClient {
  private client: MqttClient | null = null;
  private connecting: Promise<MqttClient> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private waiter: ((responses: DynsecResponse[]) => void) | null = null;

  private async connect(): Promise<MqttClient> {
    if (this.client?.connected) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<MqttClient>((resolvePromise, reject) => {
      const ca = readCaFile();
      const client = mqtt.connect(env.MQTT_URL, {
        clientId: `zenstier-provisioner-${process.pid}`,
        username: env.MQTT_PROVISIONER_USERNAME,
        password: env.MQTT_PROVISIONER_PASSWORD,
        protocolVersion: 4,
        clean: true,
        reconnectPeriod: 2_000,
        connectTimeout: 10_000,
        ...(ca ? { ca: [ca], rejectUnauthorized: true } : {}),
      });

      client.on("message", (topic, payload) => {
        if (topic !== RESPONSE_TOPIC) return;
        try {
          const parsed = JSON.parse(payload.toString()) as {
            responses?: DynsecResponse[];
          };
          this.waiter?.(parsed.responses ?? []);
        } catch (err) {
          log.error("unparseable dynsec response", { error: String(err) });
        }
      });

      client.on("error", (err) => {
        log.error("dynsec client error", { error: String(err) });
        reject(err);
      });

      client.once("connect", () => {
        client.subscribe(RESPONSE_TOPIC, { qos: 0 }, (err) => {
          if (err) return reject(err);
          log.info("dynsec control channel ready");
          this.client = client;
          resolvePromise(client);
        });
      });
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  /** Sends a batch of control commands and resolves with their responses. */
  async send(commands: DynsecCommand[]): Promise<DynsecResponse[]> {
    const run = async (): Promise<DynsecResponse[]> => {
      const client = await this.connect();

      return new Promise<DynsecResponse[]>((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          this.waiter = null;
          reject(new Error("dynsec request timed out"));
        }, REQUEST_TIMEOUT_MS);

        this.waiter = (responses) => {
          clearTimeout(timer);
          this.waiter = null;
          resolvePromise(responses);
        };

        client.publish(
          CONTROL_TOPIC,
          JSON.stringify({ commands }),
          { qos: 1 },
          (err) => {
            if (err) {
              clearTimeout(timer);
              this.waiter = null;
              reject(err);
            }
          },
        );
      });
    };

    // Serialise: one batch in flight at a time.
    const task = this.queue.then(run, run);
    this.queue = task.catch(() => undefined);
    return task;
  }

  async close(): Promise<void> {
    await this.client?.endAsync();
    this.client = null;
  }
}

const globalForDynsec = globalThis as unknown as {
  __zenstierDynsec?: DynsecClient;
};

export const dynsec: DynsecClient =
  globalForDynsec.__zenstierDynsec ?? new DynsecClient();
globalForDynsec.__zenstierDynsec = dynsec;

/** Treats "already exists" style errors as success so calls stay idempotent. */
export function assertDynsecOk(
  responses: DynsecResponse[],
  { tolerate = [] as string[] } = {},
): void {
  const fatal = responses.filter((r) => {
    if (!r.error) return false;
    const msg = r.error.toLowerCase();
    if (msg.includes("already exists")) return false;
    return !tolerate.some((t) => msg.includes(t.toLowerCase()));
  });

  if (fatal.length) {
    throw new Error(
      `dynsec command failed: ${fatal
        .map((f) => `${f.command}: ${f.error}`)
        .join("; ")}`,
    );
  }
}
