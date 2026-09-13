/**
 * Mosquitto dynamic-security role definitions.
 *
 * `%u` is substituted by the broker with the authenticated username. Because a
 * device's MQTT username IS its public device id, one role covers the entire
 * fleet while still isolating every device to its own topics.
 *
 * Requires Mosquitto >= 2.1 — pattern substitution in dynsec ACLs does not
 * exist in 2.0.x.
 */
export const DEVICE_ROLE = "zenstier-device";
export const SERVER_ROLE = "zenstier-server";
export const PROVISIONER_ROLE = "zenstier-provisioner";

export const broadcastRoleName = (groupId: string) =>
  `zenstier-bcast-${groupId}`;
export const broadcastGroupName = (groupId: string) =>
  `zenstier-grp-${groupId}`;

/**
 * Both gates are closed by default. `publishClientReceive` in particular
 * defaults to ALLOW in Mosquitto, which would make the subscribe ACL the only
 * barrier between devices.
 */
export const defaultAclAccess = {
  command: "setDefaultACLAccess",
  acls: [
    { acltype: "publishClientSend", allow: false },
    { acltype: "publishClientReceive", allow: false },
    { acltype: "subscribe", allow: false },
    { acltype: "unsubscribe", allow: true },
  ],
};

export const deviceRole = {
  command: "createRole",
  rolename: DEVICE_ROLE,
  textdescription: "Per-device access scoped by %u == device id",
  acls: [
    // Receive commands addressed to this device only.
    { acltype: "subscribePattern", topic: "zenstier/%u/command", priority: 0, allow: true },
    { acltype: "publishClientReceive", topic: "zenstier/%u/command", priority: 0, allow: true },
    { acltype: "unsubscribePattern", topic: "zenstier/%u/command", priority: 0, allow: true },

    // Report results and presence for this device only.
    { acltype: "publishClientSend", topic: "zenstier/%u/result", priority: 0, allow: true },
    { acltype: "publishClientSend", topic: "zenstier/%u/status", priority: 0, allow: true },

    // Devices may never reach the control plane or broker internals.
    { acltype: "publishClientSend", topic: "$CONTROL/#", priority: 100, allow: false },
    { acltype: "subscribePattern", topic: "$CONTROL/#", priority: 100, allow: false },
    { acltype: "subscribePattern", topic: "$SYS/#", priority: 100, allow: false },
  ],
};

export const serverRole = {
  command: "createRole",
  rolename: SERVER_ROLE,
  textdescription: "Backend data plane: dispatch commands, ingest results",
  acls: [
    { acltype: "publishClientSend", topic: "zenstier/+/command", priority: 0, allow: true },
    { acltype: "publishClientSend", topic: "zenstier/broadcast/+/command", priority: 0, allow: true },
    { acltype: "publishClientSend", topic: "zenstier/+/status", priority: 0, allow: true },

    { acltype: "subscribePattern", topic: "zenstier/+/result", priority: 0, allow: true },
    { acltype: "subscribePattern", topic: "zenstier/+/status", priority: 0, allow: true },
    { acltype: "publishClientReceive", topic: "zenstier/+/result", priority: 0, allow: true },
    { acltype: "publishClientReceive", topic: "zenstier/+/status", priority: 0, allow: true },
    { acltype: "unsubscribePattern", topic: "zenstier/#", priority: 0, allow: true },

    { acltype: "subscribePattern", topic: "$SYS/broker/uptime", priority: 0, allow: true },
    { acltype: "publishClientReceive", topic: "$SYS/broker/uptime", priority: 0, allow: true },

    // A compromised worker must not be able to forge command output
    // into the audit trail, nor mint credentials.
    { acltype: "publishClientSend", topic: "zenstier/+/result", priority: 100, allow: false },
    { acltype: "publishClientSend", topic: "$CONTROL/#", priority: 100, allow: false },
    { acltype: "subscribePattern", topic: "$CONTROL/#", priority: 100, allow: false },
  ],
};

export const provisionerRole = {
  command: "createRole",
  rolename: PROVISIONER_ROLE,
  textdescription: "Credential lifecycle only. No access to application topics.",
  acls: [
    { acltype: "publishClientSend", topic: "$CONTROL/dynamic-security/v1", priority: 0, allow: true },
    { acltype: "subscribePattern", topic: "$CONTROL/dynamic-security/v1/response", priority: 0, allow: true },
    { acltype: "publishClientReceive", topic: "$CONTROL/dynamic-security/v1/response", priority: 0, allow: true },
    { acltype: "unsubscribePattern", topic: "$CONTROL/dynamic-security/v1/response", priority: 0, allow: true },

    { acltype: "publishClientSend", topic: "zenstier/#", priority: 100, allow: false },
    { acltype: "subscribePattern", topic: "zenstier/#", priority: 100, allow: false },
  ],
};
