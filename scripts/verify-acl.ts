/**
 * Security test suite for the Mosquitto ACL model.
 *
 * Creates two throwaway device credentials and asserts that a device cannot
 * reach any topic but its own. Run after any change to roles.ts or
 * mosquitto.conf.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import mqtt, { type MqttClient } from "mqtt";
import { DEVICE_ROLE } from "../src/server/infrastructure/mqtt/roles";

const CONTROL = "$CONTROL/dynamic-security/v1";
const RESPONSE = "$CONTROL/dynamic-security/v1/response";
const A = "test-device-aaa";
const B = "test-device-bbb";
const PASS = "test-password-not-secret-1234";
const OBSERVER = "test-observer-zzz";
const OBSERVER_ROLE = "zenstier-acltest-observer";

const url = process.env.MQTT_URL!;
const ca = process.env.MQTT_CA_FILE
  ? [readFileSync(resolve(process.cwd(), process.env.MQTT_CA_FILE))]
  : undefined;

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

async function admin(): Promise<MqttClient> {
  const c = await mqtt.connectAsync(url, {
    clientId: "zenstier-acltest-admin",
    username: process.env.MQTT_ADMIN_USERNAME,
    password: process.env.MQTT_ADMIN_PASSWORD,
    protocolVersion: 4,
    clean: true,
    ...(ca ? { ca, rejectUnauthorized: true } : {}),
  });
  await c.subscribeAsync(RESPONSE, { qos: 0 });
  return c;
}

function ctrl(c: MqttClient, commands: Record<string, unknown>[]) {
  return new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("control timeout")), 5000);
    const on = (topic: string) => {
      if (topic !== RESPONSE) return;
      clearTimeout(t);
      c.off("message", on);
      res();
    };
    c.on("message", on);
    c.publish(CONTROL, JSON.stringify({ commands }), { qos: 1 });
  });
}

async function deviceClient(id: string): Promise<MqttClient> {
  return mqtt.connectAsync(url, {
    clientId: id,
    username: id,
    password: PASS,
    protocolVersion: 4,
    clean: true,
    ...(ca ? { ca, rejectUnauthorized: true } : {}),
  });
}

/** A denied SUBSCRIBE returns granted QoS 128 rather than erroring. */
async function subscribeAllowed(c: MqttClient, topic: string) {
  try {
    const granted = await c.subscribeAsync(topic, { qos: 1 });
    return granted.every((g) => g.qos !== 128);
  } catch {
    return false;
  }
}

/**
 * A denied PUBLISH at QoS 1 is silently dropped by Mosquitto (3.1.1 has no
 * negative ack), so we verify by round-trip: the backend account listens and
 * we assert nothing arrives.
 */
async function publishReaches(
  listener: MqttClient,
  publisher: MqttClient,
  topic: string,
): Promise<boolean> {
  const marker = `probe-${Date.now()}-${Math.random()}`;
  return new Promise((res) => {
    const timer = setTimeout(() => {
      listener.off("message", on);
      res(false);
    }, 1200);
    const on = (t: string, p: Buffer) => {
      if (t === topic && p.toString() === marker) {
        clearTimeout(timer);
        listener.off("message", on);
        res(true);
      }
    };
    listener.on("message", on);
    publisher.publish(topic, marker, { qos: 1 });
  });
}

async function main() {
  const adm = await admin();
  for (const id of [A, B]) {
    await ctrl(adm, [
      {
        command: "createClient",
        username: id,
        password: PASS,
        clientid: id,
        roles: [{ rolename: DEVICE_ROLE, priority: 0 }],
      },
    ]);
    await ctrl(adm, [{ command: "setClientPassword", username: id, password: PASS }]);
  }

  // A throwaway observer with read access to everything under zenstier/#,
  // so the suite can prove that a *denied* publish never reaches the broker.
  // The production server role deliberately cannot subscribe to command
  // topics, so it is unsuitable as a listener here.
  await ctrl(adm, [
    {
      command: "createRole",
      rolename: OBSERVER_ROLE,
      acls: [
        { acltype: "subscribePattern", topic: "zenstier/#", priority: 0, allow: true },
        { acltype: "publishClientReceive", topic: "zenstier/#", priority: 0, allow: true },
      ],
    },
  ]);
  await ctrl(adm, [
    {
      command: "createClient",
      username: OBSERVER,
      password: PASS,
      roles: [{ rolename: OBSERVER_ROLE, priority: 0 }],
    },
  ]);
  await ctrl(adm, [
    { command: "setClientPassword", username: OBSERVER, password: PASS },
  ]);

  const server = await mqtt.connectAsync(url, {
    clientId: "zenstier-acltest-observer",
    username: OBSERVER,
    password: PASS,
    protocolVersion: 4,
    clean: true,
    ...(ca ? { ca, rejectUnauthorized: true } : {}),
  });
  await server.subscribeAsync("zenstier/#", { qos: 1 });

  const a = await deviceClient(A);

  console.log("\nALLOWED operations:");
  check("subscribe own command topic", await subscribeAllowed(a, `zenstier/${A}/command`));
  check("publish own result topic", await publishReaches(server, a, `zenstier/${A}/result`));
  check("publish own status topic", await publishReaches(server, a, `zenstier/${A}/status`));

  console.log("\nDENIED operations (isolation):");
  check("subscribe ANOTHER device's command topic", !(await subscribeAllowed(a, `zenstier/${B}/command`)));
  check("subscribe wildcard zenstier/+/command", !(await subscribeAllowed(a, "zenstier/+/command")));
  check("subscribe wildcard zenstier/#", !(await subscribeAllowed(a, "zenstier/#")));
  check("subscribe root wildcard #", !(await subscribeAllowed(a, "#")));
  check("subscribe $SYS/#", !(await subscribeAllowed(a, "$SYS/#")));
  check("subscribe dynsec response topic", !(await subscribeAllowed(a, RESPONSE)));
  check("subscribe ANOTHER device's result topic", !(await subscribeAllowed(a, `zenstier/${B}/result`)));

  console.log("\nDENIED publishes (command injection):");
  check("publish to OWN command topic", !(await publishReaches(server, a, `zenstier/${A}/command`)));
  check("publish to ANOTHER device's command topic", !(await publishReaches(server, a, `zenstier/${B}/command`)));
  check("publish to ANOTHER device's result topic", !(await publishReaches(server, a, `zenstier/${B}/result`)));
  check("publish to broadcast command topic", !(await publishReaches(server, a, "zenstier/broadcast/g1/command")));

  console.log("\nRevocation kills the LIVE session:");
  const wasConnected = a.connected;
  const closed = new Promise<boolean>((res) => {
    const t = setTimeout(() => res(false), 4000);
    a.once("close", () => {
      clearTimeout(t);
      res(true);
    });
  });
  await ctrl(adm, [{ command: "deleteClient", username: A }]);
  const kicked = await closed;
  check("live session terminated by deleteClient", wasConnected && kicked);

  a.end(true);
  await ctrl(adm, [{ command: "deleteClient", username: B }]);
  await server.endAsync();
  await ctrl(adm, [{ command: "deleteClient", username: OBSERVER }]);
  await ctrl(adm, [{ command: "deleteRole", rolename: OBSERVER_ROLE }]);
  await adm.endAsync();

  console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("suite error:", e);
  process.exit(1);
});
