/** Dispatches a command to a device and waits for the recorded result. */
import "dotenv/config";
import { prisma } from "../src/server/infrastructure/db/prisma";
import { dispatchCommand } from "../src/server/modules/commands/command.service";

async function main() {
  const [deviceId, ...rest] = process.argv.slice(2);
  const command = rest.join(" ") || "echo hello from zenstier; uname -sr";

  const device = await prisma.device.findUnique({ where: { deviceId } });
  if (!device) throw new Error(`unknown device ${deviceId}`);

  console.log(`→ dispatching: ${command}`);
  const out = await dispatchCommand(device.userId, device.teamId, {
    command,
    deviceIds: [deviceId],
    timeoutMs: 30_000,
    useBroadcastTopic: false,
    groupId: null,
  });
  console.log(`  batch ${out.batchId}, ${out.dispatched.length} target(s)`);
  if (out.skipped.length) console.log("  skipped:", out.skipped);

  const commandId = out.dispatched[0]!.commandId;
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const row = await prisma.command.findUnique({ where: { id: commandId } });
    if (row && ["SUCCEEDED", "FAILED", "TIMEOUT", "CANCELED"].includes(row.status)) {
      console.log(`\n← status:   ${row.status}`);
      console.log(`← exit:     ${row.exitCode}`);
      console.log(`← duration: ${row.durationMs} ms`);
      console.log(`← stdout:\n${row.stdout}`);
      if (row.stderr) console.log(`← stderr:\n${row.stderr}`);

      const chunks = await prisma.commandOutput.findMany({
        where: { commandId },
        orderBy: { seq: "asc" },
      });
      console.log(`← streamed chunks: ${chunks.length}`);

      await prisma.$disconnect();
      process.exit(row.status === "SUCCEEDED" ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.error("timed out waiting for the result");
  await prisma.$disconnect();
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
