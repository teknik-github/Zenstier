/**
 * Turns an audit row into a sentence a person can read.
 *
 * Rows store internal ids so they stay correct when things are renamed, but a
 * raw cuid tells an operator nothing. The metadata captured at write time
 * carries the human-facing names, so the UI reads from that and falls back to
 * the id only when there is nothing better.
 */
export interface AuditEntryLike {
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
}

function meta(entry: AuditEntryLike): Record<string, unknown> {
  return entry.metadata && typeof entry.metadata === "object"
    ? (entry.metadata as Record<string, unknown>)
    : {};
}

/** Prisma cuid: 'c' followed by 24 lowercase alphanumerics. */
const INTERNAL_ID = /^c[a-z0-9]{24}$/;

/**
 * Reads a display string, rejecting anything that is plainly an internal id.
 *
 * Audit rows are append-only and never rewritten, so entries written before a
 * field carried human names still hold raw ids. Those degrade to "a group"
 * rather than showing a cuid the reader cannot act on.
 */
function str(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (INTERNAL_ID.test(value)) return null;
  return value;
}

const ACTION_LABELS: Record<string, string> = {
  USER_REGISTERED: "Account created",
  USER_LOGIN: "Signed in",
  USER_LOGIN_FAILED: "Failed sign-in",
  USER_2FA_ENABLED: "Two-factor enabled",
  USER_2FA_DISABLED: "Two-factor disabled",
  USER_2FA_RECOVERY_USED: "Recovery code used",
  DEVICE_ENROLLED: "Device enrolled",
  DEVICE_DELETED: "Device deleted",
  DEVICE_STATUS_CHANGED: "Device status changed",
  TOKEN_CREATED: "Enrollment token issued",
  TOKEN_REVOKED: "Credentials revoked",
  COMMAND_DISPATCHED: "Command dispatched",
  COMMAND_COMPLETED: "Command completed",
  COMMAND_RATE_LIMITED: "Command rate limited",
  TEAM_CREATED: "Team created",
  TEAM_MEMBER_INVITED: "Member invited",
  TEAM_MEMBER_JOINED: "Member joined",
  TEAM_MEMBER_REMOVED: "Member removed",
  TEAM_MEMBER_ROLE_CHANGED: "Member role changed",
  TEAM_ROLE_CREATED: "Role created",
  TEAM_ROLE_UPDATED: "Role updated",
  TEAM_ROLE_DELETED: "Role deleted",
  TEAM_INVITE_REVOKED: "Invite revoked",
  TEAM_SETTINGS_UPDATED: "Team settings updated",
  TEAM_DELETED: "Team deleted",
  DEVICE_GROUP_CREATED: "Broadcast group created",
  DEVICE_GROUP_UPDATED: "Broadcast group changed",
  DEVICE_GROUP_DELETED: "Broadcast group deleted",
  AI_CONSULTED: "AI console used",
  SCHEDULE_CREATED: "Schedule created",
  SCHEDULE_UPDATED: "Schedule updated",
  SCHEDULE_DELETED: "Schedule deleted",
  SCHEDULE_RAN: "Schedule ran",
  ALERT_RULE_CREATED: "Alert rule created",
  ALERT_RULE_UPDATED: "Alert rule updated",
  ALERT_RULE_DELETED: "Alert rule deleted",
  ALERT_FIRED: "Alert fired",
};

export function auditLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.toLowerCase().replace(/_/g, " ");
}

/** A short, human phrase describing what the entry affected. */
export function auditDetail(entry: AuditEntryLike): string {
  const m = meta(entry);

  switch (entry.action) {
    case "DEVICE_GROUP_CREATED":
    case "DEVICE_GROUP_DELETED":
      return str(m.name) ?? "a group";

    case "DEVICE_GROUP_UPDATED": {
      const device = str(m.device) ?? str(m.deviceId);
      const to = str(m.to);
      const from = str(m.from);
      if (device && to) return `${device} → ${to}`;
      if (device && from) return `${device} removed from ${from}`;
      if (device) return `${device} ungrouped`;
      return str(m.name) ?? "a group";
    }

    case "TOKEN_CREATED":
    case "TOKEN_REVOKED":
    case "DEVICE_ENROLLED":
    case "DEVICE_DELETED":
      return str(m.deviceId) ?? str(m.name) ?? "a device";

    case "COMMAND_DISPATCHED": {
      const command = str(m.command);
      const targets = Array.isArray(m.deviceIds) ? m.deviceIds.length : 0;
      if (command) {
        const shortened =
          command.length > 60 ? `${command.slice(0, 60)}…` : command;
        return targets
          ? `${shortened} · ${targets} device${targets === 1 ? "" : "s"}`
          : shortened;
      }
      return "a command";
    }

    case "COMMAND_RATE_LIMITED": {
      const wait = m.retryAfterMs;
      return typeof wait === "number"
        ? `retry in ${Math.ceil(wait / 1000)}s`
        : "throttled";
    }

    case "TEAM_CREATED":
    case "TEAM_SETTINGS_UPDATED":
    case "TEAM_DELETED":
      return str(m.name) ?? "the team";

    case "TEAM_MEMBER_INVITED":
      return [str(m.email), str(m.role)].filter(Boolean).join(" as ") || "a member";

    case "TEAM_MEMBER_REMOVED":
      return m.self === true ? "left the team" : (str(m.email) ?? "a member");

    case "TEAM_MEMBER_JOINED":
      return str(m.role) ? `as ${str(m.role)}` : "joined";

    case "TEAM_MEMBER_ROLE_CHANGED": {
      const from = str(m.from);
      const to = str(m.to);
      return from && to ? `${from} → ${to}` : (to ?? "role changed");
    }

    case "TEAM_ROLE_CREATED":
    case "TEAM_ROLE_UPDATED":
    case "TEAM_ROLE_DELETED": {
      const name = str(m.name);
      const count = Array.isArray(m.permissions) ? m.permissions.length : null;
      if (name && count !== null) {
        return `${name} · ${count} permission${count === 1 ? "" : "s"}`;
      }
      return name ?? "a role";
    }

    case "ALERT_FIRED": {
      const name = str(m.name);
      const device = str(m.device);
      const value = typeof m.value === "number" ? `${m.value}%` : null;
      return [name, device, value].filter(Boolean).join(" · ") || "an alert";
    }

    case "ALERT_RULE_CREATED":
    case "ALERT_RULE_UPDATED":
    case "ALERT_RULE_DELETED":
      return str(m.name) ?? "a rule";

    case "SCHEDULE_CREATED":
    case "SCHEDULE_UPDATED":
    case "SCHEDULE_DELETED":
      return str(m.name) ?? "a schedule";

    case "SCHEDULE_RAN": {
      const name = str(m.name);
      const n = typeof m.devices === "number" ? m.devices : null;
      return name && n !== null
        ? `${name} · ${n} device${n === 1 ? "" : "s"}`
        : (name ?? "a schedule");
    }

    case "AI_CONSULTED": {
      const prompt = str(m.prompt);
      if (!prompt) return "a question";
      return prompt.length > 70 ? `${prompt.slice(0, 70)}…` : prompt;
    }

    case "TEAM_INVITE_REVOKED":
      return str(m.email) ?? "an invite";

    default:
      // Never fall back to a bare cuid: it is noise to a reader.
      return str(m.name) ?? str(m.deviceId) ?? entry.targetType ?? "";
  }
}
