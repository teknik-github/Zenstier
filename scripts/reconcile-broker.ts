/**
 * Reconciles broker state against the database.
 *
 * The services keep both sides in step, but anything that edits the database
 * directly — a manual SQL fix, a restore from backup, an interrupted delete —
 * leaves credentials or roles behind on the broker. Those are exactly the
 * leftovers that matter: an orphaned device credential is a machine that can
 * still connect after it was removed.
 *
 *   pnpm dynsec:reconcile          report only
 *   pnpm dynsec:reconcile --fix    remove the orphans
 */
import "dotenv/config";
import { prisma } from "../src/server/infrastructure/db/prisma";
import { dynsec, assertDynsecOk } from "../src/server/infrastructure/mqtt/dynsec";
import {
  broadcastGroupName,
  broadcastRoleName,
} from "../src/server/infrastructure/mqtt/roles";

const FIX = process.argv.includes("--fix");

interface ListResponse {
  command: string;
  data?: { roles?: string[]; clients?: string[] };
}

async function main() {
  const [groups, tokens] = await Promise.all([
    prisma.deviceGroup.findMany({ select: { id: true, name: true } }),
    prisma.authToken.findMany({
      where: { status: { not: "REVOKED" } },
      select: { mqttUsername: true },
    }),
  ]);
  const knownGroups = new Set(groups.map((g) => g.id));
  const knownClients = new Set(tokens.map((t) => t.mqttUsername));

  const roleRes = (await dynsec.send([
    { command: "listRoles", count: -1 },
  ])) as ListResponse[];
  const clientRes = (await dynsec.send([
    { command: "listClients", count: -1 },
  ])) as ListResponse[];

  const broadcastRoles = (roleRes[0]?.data?.roles ?? []).filter((r) =>
    r.startsWith("zenstier-bcast-"),
  );
  // Service accounts are seeded, not derived from a token, so exclude them.
  const deviceClients = (clientRes[0]?.data?.clients ?? []).filter(
    (c) => c.startsWith("dev-") && !knownClients.has(c),
  );

  const orphanRoles = broadcastRoles.filter(
    (r) => !knownGroups.has(r.replace("zenstier-bcast-", "")),
  );

  console.log(`groups in database:        ${groups.length}`);
  console.log(`broadcast roles on broker: ${broadcastRoles.length}`);
  console.log(`orphaned roles:            ${orphanRoles.length}`);
  console.log(`orphaned device creds:     ${deviceClients.length}`);

  if (orphanRoles.length === 0 && deviceClients.length === 0) {
    console.log("\n✓ broker and database agree");
    await prisma.$disconnect();
    process.exit(0);
  }

  for (const role of orphanRoles) console.log(`  role   ${role}`);
  for (const client of deviceClients) console.log(`  client ${client}`);

  if (!FIX) {
    console.log("\nRe-run with --fix to remove them.");
    await prisma.$disconnect();
    process.exit(1);
  }

  for (const role of orphanRoles) {
    const id = role.replace("zenstier-bcast-", "");
    assertDynsecOk(
      await dynsec.send([
        { command: "deleteGroup", groupname: broadcastGroupName(id) },
      ]),
      { tolerate: ["not found"] },
    );
    assertDynsecOk(
      await dynsec.send([
        { command: "deleteRole", rolename: broadcastRoleName(id) },
      ]),
      { tolerate: ["not found"] },
    );
    console.log(`  removed role ${role}`);
  }

  for (const client of deviceClients) {
    assertDynsecOk(
      await dynsec.send([{ command: "deleteClient", username: client }]),
      { tolerate: ["not found"] },
    );
    console.log(`  removed credential ${client}`);
  }

  console.log("\n✓ reconciled");
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("reconcile failed:", err);
  process.exit(1);
});
