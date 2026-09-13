/**
 * End-to-end broadcast test.
 *
 * Proves that ONE publish to a group topic reaches every member, that each
 * agent derives its own command id, and that every run is still audited per
 * device.
 */
import "dotenv/config";
import { prisma } from "../src/server/infrastructure/db/prisma";
import {
  createGroup,
  setDeviceGroup,
  deleteGroup,
} from "../src/server/modules/devices/group.service";
import { dispatchCommand } from "../src/server/modules/commands/command.service";

async function main() {
  // Whoever owns the fleet on this install: an argument, then an env var, then
  // simply the first account. Never a hard-coded address.
  const email = process.argv[2] ?? process.env.ZENSTIER_OWNER_EMAIL;
  const user = email
    ? await prisma.user.findUniqueOrThrow({ where: { email } })
    : await prisma.user.findFirstOrThrow({
        where: { memberships: { some: { team: { devices: { some: {} } } } } },
        orderBy: { createdAt: "asc" },
      });
  const teamId = (await prisma.teamMember.findFirstOrThrow({
    where: { userId: user.id },
  })).teamId;

  const online = await prisma.device.findMany({
    where: { teamId, status: "ONLINE" },
  });
  console.log(`online devices: ${online.map((d) => d.name).join(", ")}`);

  const group = await createGroup(user.id, teamId, `bcast-test-${Date.now()}`);
  console.log(`created group ${group.name} (${group.id})`);

  for (const device of online) {
    await setDeviceGroup(user.id, teamId, device.deviceId, group.id);
  }
  console.log(`assigned ${online.length} device(s)`);

  // Give the agents a moment to process update_groups and resubscribe.
  await new Promise((r) => setTimeout(r, 2500));

  console.log("\n→ dispatching via the group BROADCAST topic (one publish)");
  const out = await dispatchCommand(user.id, teamId, {
    command: "echo broadcast-reached $(hostname)",
    deviceIds: [],
    groupId: group.id,
    timeoutMs: 20000,
    useBroadcastTopic: true,
  });
  console.log(`  batch ${out.batchId} -> ${out.dispatched.length} device row(s)`);

  await new Promise((r) => setTimeout(r, 5000));

  let reached = 0;
  for (const d of out.dispatched) {
    const row = await prisma.command.findUnique({
      where: { id: d.commandId },
      include: { device: true },
    });
    const ok = row?.status === "SUCCEEDED";
    if (ok) reached++;
    console.log(
      `  ${ok ? "✓" : "✗"} ${row?.device.name}: ${row?.status} — ${(row?.stdout ?? "").trim()}`,
    );
  }

  await deleteGroup(user.id, teamId, group.id);
  console.log(`\ncleaned up group`);
  console.log(
    `${reached === online.length ? "✓" : "✗"} broadcast reached ${reached}/${online.length} devices`,
  );

  await prisma.$disconnect();
  process.exit(reached === online.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
