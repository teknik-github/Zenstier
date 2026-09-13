import "server-only";
import { DeviceStatus } from "@/generated/prisma/enums";
import { prisma } from "@/server/infrastructure/db/prisma";
import type { OsInfo } from "@/lib/protocol";

export function listDevicesForUser(userId: string) {
  return prisma.device.findMany({
    where: { userId },
    orderBy: [{ status: "asc" }, { name: "asc" }],
    include: { group: { select: { id: true, name: true } } },
  });
}

export function findDeviceForUser(userId: string, deviceId: string) {
  return prisma.device.findFirst({
    where: { userId, deviceId },
    include: { group: { select: { id: true, name: true } } },
  });
}

/** Looks up by public deviceId without a tenancy filter (worker use only). */
export function findDeviceByPublicId(deviceId: string) {
  return prisma.device.findUnique({ where: { deviceId } });
}

export async function markDeviceStatus(
  deviceId: string,
  status: DeviceStatus,
  os?: OsInfo,
  agentVersion?: string,
) {
  return prisma.device.update({
    where: { deviceId },
    data: {
      status,
      lastSeenAt: new Date(),
      ...(os
        ? {
            hostname: os.hostname ?? undefined,
            osName: os.distro ?? undefined,
            osVersion: os.version ?? undefined,
            kernel: os.kernel ?? undefined,
            arch: os.arch ?? undefined,
          }
        : {}),
      ...(agentVersion ? { agentVersion } : {}),
    },
  });
}

export function touchLastSeen(deviceId: string) {
  return prisma.device.update({
    where: { deviceId },
    data: { lastSeenAt: new Date() },
  });
}

export function listDeviceIdsForUser(userId: string, ids: string[]) {
  return prisma.device.findMany({
    where: { userId, deviceId: { in: ids } },
    select: { id: true, deviceId: true, status: true, name: true },
  });
}

export function listDevicesInGroup(userId: string, groupId: string) {
  return prisma.device.findMany({
    where: { userId, groupId },
    select: { id: true, deviceId: true, status: true, name: true },
  });
}
