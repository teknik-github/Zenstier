import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

/**
 * Reads the current session. Deduplicated per request via React `cache` so
 * multiple callers in one render do not re-verify the JWT.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    email: session.user.email ?? "",
    name: session.user.name ?? null,
  };
});

/**
 * The authorisation boundary. Every Server Action, Route Handler and protected
 * page must call this — the proxy is only an optimistic redirect.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** Same check for API routes, which must return 401 rather than redirect. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

export async function requireApiUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}
