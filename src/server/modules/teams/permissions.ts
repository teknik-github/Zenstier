/**
 * Permission catalogue.
 *
 * Permissions are plain slugs stored on a Role. Keeping them as data (rather
 * than hard-coded role checks) is what lets an admin compose arbitrary roles
 * without a code change.
 */

export const PERMISSIONS = [
  // Fleet
  "device:read",
  "device:create",
  "device:update",
  "device:delete",
  "device:revoke",
  // Execution
  "command:read",
  "command:execute",
  // Governance
  "audit:read",
  "team:read",
  "team:manage_members",
  "team:manage_roles",
  "team:manage_settings",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_SET = new Set<string>(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

export interface PermissionMeta {
  key: Permission;
  group: string;
  label: string;
  description: string;
  /** Marks permissions that grant destructive or privilege-granting power. */
  sensitive?: boolean;
}

export const PERMISSION_CATALOGUE: PermissionMeta[] = [
  {
    key: "device:read",
    group: "Devices",
    label: "View devices",
    description: "See the device list, status and resource metrics.",
  },
  {
    key: "device:create",
    group: "Devices",
    label: "Enroll devices",
    description: "Generate enrollment tokens and add new devices.",
  },
  {
    key: "device:update",
    group: "Devices",
    label: "Edit devices",
    description: "Rename devices and change their group.",
  },
  {
    key: "device:revoke",
    group: "Devices",
    label: "Revoke credentials",
    description: "Disconnect a device and invalidate its broker credentials.",
    sensitive: true,
  },
  {
    key: "device:delete",
    group: "Devices",
    label: "Delete devices",
    description: "Permanently remove a device along with its history.",
    sensitive: true,
  },
  {
    key: "command:read",
    group: "Commands",
    label: "View command history",
    description: "Read past commands and their output.",
  },
  {
    key: "command:execute",
    group: "Commands",
    label: "Run commands",
    description: "Execute shell commands as root on team devices.",
    sensitive: true,
  },
  {
    key: "audit:read",
    group: "Governance",
    label: "View audit log",
    description: "Read the record of who did what, and when.",
  },
  {
    key: "team:read",
    group: "Governance",
    label: "View team",
    description: "See team members and their roles.",
  },
  {
    key: "team:manage_members",
    group: "Governance",
    label: "Manage members",
    description: "Invite, remove and reassign the roles of team members.",
    sensitive: true,
  },
  {
    key: "team:manage_roles",
    group: "Governance",
    label: "Manage roles",
    description: "Create and edit roles and the permissions they grant.",
    sensitive: true,
  },
  {
    key: "team:manage_settings",
    group: "Governance",
    label: "Manage team settings",
    description: "Rename the team and change team-wide settings.",
    sensitive: true,
  },
];

export const PERMISSION_GROUPS = [
  "Devices",
  "Commands",
  "Governance",
] as const;

/**
 * Roles seeded into every new team.
 *
 * `rank` decides authority: a member can never edit, remove or out-rank
 * someone whose role ranks at or above their own.
 */
export interface SystemRoleSpec {
  name: string;
  description: string;
  rank: number;
  permissions: Permission[];
}

export const OWNER_ROLE = "Owner";

export const SYSTEM_ROLES: SystemRoleSpec[] = [
  {
    name: OWNER_ROLE,
    description: "Full control, including team settings and membership.",
    rank: 100,
    permissions: [...PERMISSIONS],
  },
  {
    name: "Admin",
    description: "Manages devices, members and roles, but not team settings.",
    rank: 80,
    permissions: PERMISSIONS.filter(
      (p) => p !== "team:manage_settings",
    ) as Permission[],
  },
  {
    name: "Operator",
    description: "Runs commands and enrolls devices. Cannot manage the team.",
    rank: 50,
    permissions: [
      "device:read",
      "device:create",
      "device:update",
      "command:read",
      "command:execute",
      "audit:read",
      "team:read",
    ],
  },
  {
    name: "Viewer",
    description: "Read-only access to devices, history and the audit log.",
    rank: 10,
    permissions: ["device:read", "command:read", "audit:read", "team:read"],
  },
];

export function groupedCatalogue() {
  return PERMISSION_GROUPS.map((group) => ({
    group,
    items: PERMISSION_CATALOGUE.filter((p) => p.group === group),
  }));
}
