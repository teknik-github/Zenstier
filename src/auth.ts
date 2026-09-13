import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/server/infrastructure/db/prisma";
import { credentialsSchema } from "@/server/modules/auth/auth.schema";
import { authenticateUser } from "@/server/modules/auth/auth.service";
import {
  clientIp,
  consumeRateLimit,
  isRateLimited,
  resetRateLimit,
} from "@/server/infrastructure/ratelimit/ratelimit";
import { logger } from "@/server/infrastructure/logger/logger";

/** Failed sign-in budget, per 15 minutes. */
const LOGIN_ACCOUNT_LIMIT = 8;
const LOGIN_IP_LIMIT = 20;
const LOGIN_WINDOW_MS = 15 * 60_000;

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  // The Credentials provider is incompatible with database sessions.
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 },
  trustHost: true,
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        totp: { label: "Two-factor code", type: "text" },
      },
      authorize: async (raw, request) => {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        // Brute-force protection lives here rather than in the server action:
        // this callback is also reached by a direct POST to
        // /api/auth/callback/credentials, which bypasses any action.
        const ip = clientIp(new Headers(request?.headers ?? {}));
        const ipKey = `login:ip:${ip}`;
        const acctKey = `login:acct:${parsed.data.email}`;

        // Check before authenticating, and charge only on FAILURE. Counting
        // every attempt would lock out someone who simply signs in often.
        const [ipBlocked, acctBlocked] = await Promise.all([
          isRateLimited(ipKey, LOGIN_IP_LIMIT),
          isRateLimited(acctKey, LOGIN_ACCOUNT_LIMIT),
        ]);
        if (ipBlocked || acctBlocked) {
          logger.warn("login blocked by rate limit", {
            module: "auth",
            ip,
            email: parsed.data.email,
          });
          return null;
        }

        const user = await authenticateUser(
          parsed.data.email,
          parsed.data.password,
        );

        if (!user) {
          await Promise.all([
            consumeRateLimit(ipKey, LOGIN_IP_LIMIT, LOGIN_WINDOW_MS),
            consumeRateLimit(acctKey, LOGIN_ACCOUNT_LIMIT, LOGIN_WINDOW_MS),
          ]);
          return null;
        }

        // Password is right; now the second factor, if the account has one.
        const { verifySecondFactor } = await import(
          "@/server/modules/auth/totp.service"
        );
        if (!(await verifySecondFactor(user.id, parsed.data.totp ?? ""))) {
          // Counts as a failed attempt: otherwise the second factor could be
          // brute-forced for free once a password is known.
          await consumeRateLimit(acctKey, LOGIN_ACCOUNT_LIMIT, LOGIN_WINDOW_MS);
          logger.warn("second factor rejected", {
            module: "auth",
            email: parsed.data.email,
          });
          return null;
        }

        // A correct sign-in clears the account's failure budget.
        await resetRateLimit(acctKey);
        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) token.sub = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
});
