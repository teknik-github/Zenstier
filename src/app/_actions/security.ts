"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/modules/auth/session";
import {
  TotpError,
  beginTotpSetup,
  confirmTotpSetup,
  disableTotp,
} from "@/server/modules/auth/totp.service";

export interface SecurityState {
  ok?: boolean;
  error?: string;
  secret?: string;
  qrSvg?: string;
  otpauthUri?: string;
  backupCodes?: string[];
}

function fail(err: unknown): SecurityState {
  if (err instanceof TotpError) return { error: err.message };
  throw err;
}

export async function beginTotpAction(): Promise<SecurityState> {
  const user = await requireUser();
  try {
    const setup = await beginTotpSetup(user.id, user.email);
    return {
      ok: true,
      secret: setup.secret,
      qrSvg: setup.qrSvg,
      otpauthUri: setup.otpauthUri,
    };
  } catch (err) {
    return fail(err);
  }
}

export async function confirmTotpAction(
  _prev: SecurityState,
  formData: FormData,
): Promise<SecurityState> {
  const user = await requireUser();
  const code = formData.get("code")?.toString() ?? "";
  try {
    const backupCodes = await confirmTotpSetup(user.id, code);
    revalidatePath("/dashboard/security");
    return { ok: true, backupCodes };
  } catch (err) {
    return fail(err);
  }
}

export async function disableTotpAction(
  _prev: SecurityState,
  formData: FormData,
): Promise<SecurityState> {
  const user = await requireUser();
  const code = formData.get("code")?.toString() ?? "";
  try {
    await disableTotp(user.id, code);
    revalidatePath("/dashboard/security");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}
