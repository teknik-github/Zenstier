"use server";

import { AuthError } from "next-auth";
import { signIn, signOut } from "@/auth";
import { registerSchema } from "@/server/modules/auth/auth.schema";
import {
  registerUser,
  EmailAlreadyRegisteredError,
} from "@/server/modules/auth/auth.service";

export interface AuthActionState {
  error?: string;
}

export async function loginAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/dashboard",
    });
    return {};
  } catch (err) {
    if (err instanceof AuthError) {
      return { error: "Invalid email or password" };
    }
    // next-auth signals a successful redirect by throwing.
    throw err;
  }
}

export async function registerAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = registerSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    await registerUser(parsed.data);
  } catch (err) {
    if (err instanceof EmailAlreadyRegisteredError) {
      return { error: "That email is already registered" };
    }
    throw err;
  }

  await signIn("credentials", {
    email: parsed.data.email,
    password: parsed.data.password,
    redirectTo: "/dashboard",
  });
  return {};
}

export async function logoutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
