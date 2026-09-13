/** Issues an enrollment token for an existing user, by email. */
import "dotenv/config";
import { prisma } from "../src/server/infrastructure/db/prisma";
import { createEnrollmentToken } from "../src/server/modules/tokens/token.service";

async function main() {
  const [email, name] = process.argv.slice(2);
  // An empty email means "whoever owns this install", so the script is not
  // tied to the account it happened to be written against.
  const user = email
    ? await prisma.user.findUnique({ where: { email } })
    : ((await prisma.user.findFirst({
        where: { memberships: { some: { team: { devices: { some: {} } } } } },
        orderBy: { createdAt: "asc" },
      })) ??
      (await prisma.user.findFirst({ orderBy: { createdAt: "asc" } })));
  if (!user) throw new Error(email ? `no user ${email}` : "no users exist yet");
  const token = await createEnrollmentToken(user.id, name ?? "device", "cli");
  console.log(JSON.stringify(token));
  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
