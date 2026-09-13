/**
 * Creates (or resets the password of) a dashboard user.
 *
 *   pnpm user:create <email> <password> [name]
 */
import "dotenv/config";
import { prisma } from "../src/server/infrastructure/db/prisma";
import { hashPassword } from "../src/server/modules/auth/password";

async function main() {
  const [email, password, ...nameParts] = process.argv.slice(2);
  if (!email || !password) {
    console.error("usage: pnpm user:create <email> <password> [name]");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("password must be at least 8 characters");
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const name = nameParts.join(" ") || null;

  const user = await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    create: { email: email.toLowerCase(), name, passwordHash },
    update: { passwordHash, ...(name ? { name } : {}) },
    select: { id: true, email: true, name: true },
  });

  console.log(`✓ user ready: ${user.email} (${user.id})`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
