/** Issues an enrollment token for an existing user, by email. */
import "dotenv/config";
import { prisma } from "../src/server/infrastructure/db/prisma";
import { createEnrollmentToken } from "../src/server/modules/tokens/token.service";

async function main() {
  const [email, name] = process.argv.slice(2);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error(`no user ${email}`);
  const token = await createEnrollmentToken(user.id, name ?? "device", "cli");
  console.log(JSON.stringify(token));
  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
