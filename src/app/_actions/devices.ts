"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/server/modules/teams/context";
import {
  createEnrollmentToken,
  revokeToken,
} from "@/server/modules/tokens/token.service";
import { prisma } from "@/server/infrastructure/db/prisma";
import { logger } from "@/server/infrastructure/logger/logger";

const log = logger.child({ module: "device-actions" });

const createDeviceSchema = z.object({
  name: z.string().trim().min(1, "Device name is required").max(120),
  label: z.string().trim().max(120).optional(),
});

export interface CreateDeviceState {
  ok?: boolean;
  error?: string;
  token?: string;
  deviceId?: string;
}

export async function createDeviceAction(
  _prev: CreateDeviceState,
  formData: FormData,
): Promise<CreateDeviceState> {
  // Server Actions are reachable by direct POST, so authorise here.
  const ctx = await requirePermission("device:create");

  const parsed = createDeviceSchema.safeParse({
    name: formData.get("name"),
    label: formData.get("label") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    const created = await createEnrollmentToken(
      ctx.user.id,
      ctx.team.id,
      parsed.data.name,
      parsed.data.label,
    );
    revalidatePath("/dashboard/devices");
    return {
      ok: true,
      token: created.plaintextToken,
      deviceId: created.deviceId,
    };
  } catch (err) {
    log.error("device creation failed", { error: String(err) });
    return { error: "Could not provision the device. Is the broker reachable?" };
  }
}

export async function revokeDeviceAction(deviceId: string): Promise<void> {
  const ctx = await requirePermission("device:revoke");

  // Scoped by team, so a member cannot reach another team's device by id.
  const device = await prisma.device.findFirst({
    where: { teamId: ctx.team.id, deviceId },
    include: { tokens: true },
  });
  if (!device) throw new Error("Device not found");

  for (const token of device.tokens) {
    await revokeToken(ctx.user.id, ctx.team.id, token.id);
  }
  revalidatePath("/dashboard/devices");
}

export async function deleteDeviceAction(deviceId: string): Promise<void> {
  const ctx = await requirePermission("device:delete");

  const device = await prisma.device.findFirst({
    where: { teamId: ctx.team.id, deviceId },
    include: { tokens: true },
  });
  if (!device) throw new Error("Device not found");

  for (const token of device.tokens) {
    await revokeToken(ctx.user.id, ctx.team.id, token.id).catch((err) =>
      log.warn("revoke during delete failed", { error: String(err) }),
    );
  }
  await prisma.device.delete({ where: { id: device.id } });
  revalidatePath("/dashboard/devices");
}
