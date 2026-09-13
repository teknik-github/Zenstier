import "server-only";
import { AuditAction } from "@/generated/prisma/enums";
import { prisma } from "@/server/infrastructure/db/prisma";
import { logger } from "@/server/infrastructure/logger/logger";
import { dynsec, assertDynsecOk } from "@/server/infrastructure/mqtt/dynsec";
import {
  broadcastGroupName,
  broadcastRoleName,
} from "@/server/infrastructure/mqtt/roles";
import { publishCommand } from "@/server/infrastructure/mqtt/publisher";
import { PROTOCOL_VERSION, topics } from "@/lib/protocol";
import { randomUUID } from "node:crypto";

const log = logger.child({ module: "device-groups" });

export class GroupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupError";
  }
}

export function listGroups(teamId: string) {
  return prisma.deviceGroup.findMany({
    where: { teamId },
    orderBy: { name: "asc" },
    include: {
      devices: {
        select: { id: true, deviceId: true, name: true, status: true },
        orderBy: { name: "asc" },
      },
    },
  });
}

/**
 * Provisions the broker side of a group.
 *
 * Pattern substitution cannot express group membership, so each RMM group gets
 * its own dynsec role (subscribe-only on that group's broadcast topic) and a
 * dynsec group that devices are added to. No `publishClientSend` is granted
 * anywhere on `broadcast/**`, so a compromised device cannot fan out commands
 * to its peers.
 */
async function provisionBrokerGroup(groupId: string) {
  assertDynsecOk(
    await dynsec.send([
      {
        command: "createRole",
        rolename: broadcastRoleName(groupId),
        textdescription: `Broadcast receive for group ${groupId}`,
        acls: [
          {
            acltype: "subscribePattern",
            topic: topics.broadcastCommand(groupId),
            priority: 0,
            allow: true,
          },
          {
            acltype: "publishClientReceive",
            topic: topics.broadcastCommand(groupId),
            priority: 0,
            allow: true,
          },
          {
            acltype: "unsubscribePattern",
            topic: topics.broadcastCommand(groupId),
            priority: 0,
            allow: true,
          },
        ],
      },
    ]),
  );

  assertDynsecOk(
    await dynsec.send([
      {
        command: "createGroup",
        groupname: broadcastGroupName(groupId),
        roles: [{ rolename: broadcastRoleName(groupId), priority: 0 }],
      },
    ]),
  );
}

export async function createGroup(
  actorId: string,
  teamId: string,
  name: string,
) {
  const trimmed = name.trim();
  if (!trimmed) throw new GroupError("Group name is required");

  const clash = await prisma.deviceGroup.findFirst({
    where: { teamId, name: trimmed },
  });
  if (clash) throw new GroupError(`A group named "${trimmed}" already exists`);

  const group = await prisma.deviceGroup.create({
    data: { teamId, userId: actorId, name: trimmed },
  });

  try {
    await provisionBrokerGroup(group.id);
  } catch (err) {
    // Do not leave a group the broker knows nothing about.
    await prisma.deviceGroup.delete({ where: { id: group.id } });
    throw new GroupError(
      `Could not provision the group on the broker: ${String(err)}`,
    );
  }

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      teamId,
      action: AuditAction.DEVICE_GROUP_CREATED,
      targetType: "device_group",
      targetId: group.id,
      metadata: { name: trimmed },
    },
  });

  log.info("device group created", { groupId: group.id, name: trimmed });
  return group;
}

export async function renameGroup(
  actorId: string,
  teamId: string,
  groupId: string,
  name: string,
) {
  const trimmed = name.trim();
  if (!trimmed) throw new GroupError("Group name is required");

  const group = await prisma.deviceGroup.findFirst({
    where: { id: groupId, teamId },
  });
  if (!group) throw new GroupError("Group not found");

  const updated = await prisma.deviceGroup.update({
    where: { id: groupId },
    data: { name: trimmed },
  });
  await prisma.auditLog.create({
    data: {
      userId: actorId,
      teamId,
      action: AuditAction.DEVICE_GROUP_UPDATED,
      targetType: "device_group",
      targetId: groupId,
      metadata: { name: trimmed },
    },
  });
  return updated;
}

export async function deleteGroup(
  actorId: string,
  teamId: string,
  groupId: string,
) {
  const group = await prisma.deviceGroup.findFirst({
    where: { id: groupId, teamId },
    include: { devices: true },
  });
  if (!group) throw new GroupError("Group not found");

  // Detach devices first so they stop listening to the broadcast topic.
  for (const device of group.devices) {
    await removeFromBrokerGroup(device.deviceId, groupId).catch((err) =>
      log.warn("could not remove device from broker group", {
        deviceId: device.deviceId,
        error: String(err),
      }),
    );
  }

  assertDynsecOk(
    await dynsec.send([
      { command: "deleteGroup", groupname: broadcastGroupName(groupId) },
    ]),
    { tolerate: ["not found"] },
  );
  assertDynsecOk(
    await dynsec.send([
      { command: "deleteRole", rolename: broadcastRoleName(groupId) },
    ]),
    { tolerate: ["not found"] },
  );

  await prisma.deviceGroup.delete({ where: { id: groupId } });

  // Tell the agents their subscriptions changed.
  for (const device of group.devices) {
    await notifyGroupsChanged(device.deviceId, []).catch(() => {});
  }

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      teamId,
      action: AuditAction.DEVICE_GROUP_DELETED,
      targetType: "device_group",
      targetId: groupId,
      metadata: { name: group.name, devices: group.devices.length },
    },
  });
}

async function addToBrokerGroup(deviceId: string, groupId: string) {
  assertDynsecOk(
    await dynsec.send([
      {
        command: "addGroupClient",
        groupname: broadcastGroupName(groupId),
        username: deviceId,
      },
    ]),
    { tolerate: ["already"] },
  );
}

async function removeFromBrokerGroup(deviceId: string, groupId: string) {
  assertDynsecOk(
    await dynsec.send([
      {
        command: "removeGroupClient",
        groupname: broadcastGroupName(groupId),
        username: deviceId,
      },
    ]),
    { tolerate: ["not found", "not in group"] },
  );
}

/**
 * An agent subscribes to broadcast topics listed in its config, which is only
 * written at enrollment. Membership changes therefore have to be pushed, or
 * the device would sit in a group it never listens to until it re-enrolls.
 */
async function notifyGroupsChanged(deviceId: string, groups: string[]) {
  await publishCommand(topics.command(deviceId), {
    v: PROTOCOL_VERSION,
    id: randomUUID(),
    type: "update_groups",
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    groups,
  });
}

/** Moves a device into a group, or out of every group when groupId is null. */
export async function setDeviceGroup(
  actorId: string,
  teamId: string,
  deviceId: string,
  groupId: string | null,
) {
  const device = await prisma.device.findFirst({
    where: { deviceId, teamId },
    include: { group: true },
  });
  if (!device) throw new GroupError("Device not found");

  let target: { id: string; name: string } | null = null;
  if (groupId) {
    const group = await prisma.deviceGroup.findFirst({
      where: { id: groupId, teamId },
      select: { id: true, name: true },
    });
    if (!group) throw new GroupError("Group not found");
    target = group;
  }

  if (device.groupId && device.groupId !== groupId) {
    await removeFromBrokerGroup(device.deviceId, device.groupId);
  }
  if (groupId && device.groupId !== groupId) {
    await addToBrokerGroup(device.deviceId, groupId);
  }

  await prisma.device.update({
    where: { id: device.id },
    data: { groupId },
  });

  // Best effort: an offline agent picks the change up at its next enrollment
  // or reconnect, and the backend can always fan out per device meanwhile.
  await notifyGroupsChanged(device.deviceId, groupId ? [groupId] : []).catch(
    (err) =>
      log.warn("could not notify agent of group change", {
        deviceId,
        error: String(err),
      }),
  );

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      teamId,
      action: AuditAction.DEVICE_GROUP_UPDATED,
      targetType: "device",
      targetId: device.id,
      metadata: {
        device: device.name,
        deviceId,
        from: device.group?.name ?? null,
        to: target?.name ?? null,
      },
    },
  });
}
