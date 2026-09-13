/**
 * Idempotently seeds Mosquitto dynamic security with the Zenstier roles and
 * the two backend service accounts.
 *
 * Runs as the dynsec `admin` account, because the service accounts it creates
 * do not exist yet. Safe to re-run.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import mqtt from "mqtt";
import {
  defaultAclAccess,
  deviceRole,
  serverRole,
  provisionerRole,
  SERVER_ROLE,
  PROVISIONER_ROLE,
} from "../src/server/infrastructure/mqtt/roles";

const CONTROL = "$CONTROL/dynamic-security/v1";
const RESPONSE = "$CONTROL/dynamic-security/v1/response";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

async function main() {
  const url = required("MQTT_URL");
  const caPath = process.env.MQTT_CA_FILE;
  const ca = caPath ? [readFileSync(resolve(process.cwd(), caPath))] : undefined;

  const client = await mqtt.connectAsync(url, {
    clientId: "zenstier-seed",
    username: required("MQTT_ADMIN_USERNAME"),
    password: required("MQTT_ADMIN_PASSWORD"),
    protocolVersion: 4,
    clean: true,
    ...(ca ? { ca, rejectUnauthorized: true } : {}),
  });

  await client.subscribeAsync(RESPONSE, { qos: 0 });

  const send = (commands: Record<string, unknown>[]) =>
    new Promise<{ command: string; error?: string }[]>((res, rej) => {
      const timer = setTimeout(() => rej(new Error("timed out")), 5000);
      const onMessage = (topic: string, payload: Buffer) => {
        if (topic !== RESPONSE) return;
        clearTimeout(timer);
        client.off("message", onMessage);
        res(JSON.parse(payload.toString()).responses ?? []);
      };
      client.on("message", onMessage);
      client.publish(CONTROL, JSON.stringify({ commands }), { qos: 1 });
    });

  const check = (
    label: string,
    responses: { command: string; error?: string }[],
  ) => {
    for (const r of responses) {
      if (r.error && !/already exists/i.test(r.error)) {
        throw new Error(`${label} → ${r.command}: ${r.error}`);
      }
      console.log(
        `  ${r.error ? "=" : "+"} ${r.command}${r.error ? ` (${r.error})` : ""}`,
      );
    }
  };

  console.log("→ default ACL access");
  check("defaults", await send([defaultAclAccess]));

  console.log("→ roles");
  check("roles", await send([deviceRole, serverRole, provisionerRole]));

  console.log("→ service accounts");
  check(
    "clients",
    await send([
      {
        command: "createClient",
        username: required("MQTT_BACKEND_USERNAME"),
        password: required("MQTT_BACKEND_PASSWORD"),
        textname: "Zenstier backend worker (data plane)",
        roles: [{ rolename: SERVER_ROLE, priority: 0 }],
      },
      {
        command: "createClient",
        username: required("MQTT_PROVISIONER_USERNAME"),
        password: required("MQTT_PROVISIONER_PASSWORD"),
        textname: "Zenstier provisioner (control plane)",
        roles: [{ rolename: PROVISIONER_ROLE, priority: 0 }],
      },
    ]),
  );

  // Re-assert passwords so a re-run repairs drift from a rotated .env.
  console.log("→ syncing service account passwords");
  check(
    "passwords",
    await send([
      {
        command: "setClientPassword",
        username: required("MQTT_BACKEND_USERNAME"),
        password: required("MQTT_BACKEND_PASSWORD"),
      },
      {
        command: "setClientPassword",
        username: required("MQTT_PROVISIONER_USERNAME"),
        password: required("MQTT_PROVISIONER_PASSWORD"),
      },
    ]),
  );

  await client.endAsync();
  console.log("\n✓ dynamic security seeded");
}

main().catch((err) => {
  console.error("✗ seeding failed:", err.message);
  process.exit(1);
});
