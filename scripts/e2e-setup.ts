/** Creates a test user and an enrollment token, printing the token as JSON. */
import "dotenv/config";
import { prisma } from "../src/server/infrastructure/db/prisma";
import { registerUser } from "../src/server/modules/auth/auth.service";
import { createEnrollmentToken } from "../src/server/modules/tokens/token.service";

async function main() {
  const email = "e2e@zenstier.local";
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    const created = await registerUser({
      email,
      name: "E2E Tester",
      password: "e2e-password-1234",
    });
    user = await prisma.user.findUnique({ where: { id: created.id } });
  }

  const name = `e2e-host-${Date.now()}`;
  const token = await createEnrollmentToken(user!.id, name, "end-to-end test");

  console.log(JSON.stringify({ userId: user!.id, ...token }));
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
