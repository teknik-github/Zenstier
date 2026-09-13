/** Revokes a device's credentials and reports how long the broker took. */
import "dotenv/config";
import { prisma } from "../src/server/infrastructure/db/prisma";
import { revokeToken } from "../src/server/modules/tokens/token.service";

async function main() {
  const deviceId = process.argv[2];
  const device = await prisma.device.findUnique({
    where: { deviceId },
    include: { tokens: true },
  });
  if (!device) throw new Error(`unknown device ${deviceId}`);

  const started = Date.now();
  for (const token of device.tokens) {
    await revokeToken(device.userId, device.teamId, token.id);
  }
  console.log(`revoked in ${Date.now() - started} ms`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
