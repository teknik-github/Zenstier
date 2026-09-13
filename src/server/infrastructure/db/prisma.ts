import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env, isProduction } from "@/server/config/env";

/**
 * Prisma singleton.
 *
 * Prisma 7 requires an explicit driver adapter. Next.js dev mode hot-reloads
 * modules on every edit; without the global cache each reload would open a
 * fresh connection pool and exhaust Postgres.
 */
const globalForPrisma = globalThis as unknown as {
  __zenstierPrisma?: PrismaClient;
};

function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({
    adapter,
    log: isProduction ? ["error"] : ["error", "warn"],
  });
}

export const prisma: PrismaClient =
  globalForPrisma.__zenstierPrisma ?? createClient();

if (!isProduction) {
  globalForPrisma.__zenstierPrisma = prisma;
}
