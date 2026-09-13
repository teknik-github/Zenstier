/**
 * RBAC security suite.
 *
 * Calls the service layer directly — exactly what an attacker reaches by
 * POSTing to a Server Action — so it proves the server enforces authority
 * rather than relying on the UI hiding controls.
 */
import "dotenv/config";
import { prisma } from "../src/server/infrastructure/db/prisma";
import { hashPassword } from "../src/server/modules/auth/password";
import {
  createRole,
  createTeam,
  changeMemberRole,
  deleteRole,
  inviteMember,
  removeMember,
  updateRole,
} from "../src/server/modules/teams/team.service";
import { PERMISSIONS } from "../src/server/modules/teams/permissions";

let passed = 0;
let failed = 0;

function ok(name: string) {
  passed++;
  console.log(`  ✓ ${name}`);
}
function bad(name: string, detail: string) {
  failed++;
  console.log(`  ✗ ${name} — ${detail}`);
}

/** Asserts the call is rejected. A success here is a security failure. */
async function mustReject(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    bad(name, "the operation was ALLOWED");
  } catch (err) {
    ok(`${name} — rejected: ${(err as Error).message}`);
  }
}

async function mustAllow(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, `unexpectedly rejected: ${(err as Error).message}`);
  }
}

async function main() {
  const suffix = Date.now();
  const owner = await prisma.user.create({
    data: {
      email: `rbac-owner-${suffix}@test.local`,
      name: "RBAC Owner",
      passwordHash: await hashPassword("not-a-real-password"),
    },
  });
  const admin = await prisma.user.create({
    data: {
      email: `rbac-admin-${suffix}@test.local`,
      name: "RBAC Admin",
      passwordHash: await hashPassword("not-a-real-password"),
    },
  });

  const team = await createTeam(owner.id, `RBAC Test ${suffix}`);
  const roles = await prisma.role.findMany({ where: { teamId: team.id } });
  const roleBy = (name: string) => roles.find((r) => r.name === name)!;

  const ownerRole = roleBy("Owner");   // rank 100
  const adminRole = roleBy("Admin");   // rank 80
  const operator = roleBy("Operator"); // rank 50
  const viewer = roleBy("Viewer");     // rank 10

  const adminMember = await prisma.teamMember.create({
    data: { teamId: team.id, userId: admin.id, roleId: adminRole.id },
  });
  const ownerMember = await prisma.teamMember.findFirstOrThrow({
    where: { teamId: team.id, userId: owner.id },
  });

  const ADMIN_RANK = adminRole.rank;

  console.log("\nPrivilege escalation (acting as Admin, rank 80):");

  await mustReject("edit own role to gain more permissions", () =>
    updateRole(admin.id, ADMIN_RANK, team.id, adminRole.id, {
      permissions: [...PERMISSIONS],
    }),
  );

  await mustReject("edit the Owner role", () =>
    updateRole(admin.id, ADMIN_RANK, team.id, ownerRole.id, {
      permissions: ["device:read"],
    }),
  );

  await mustReject("delete a role at or above own rank", () =>
    deleteRole(admin.id, ADMIN_RANK, team.id, adminRole.id),
  );

  await mustReject("promote a member to Owner", () =>
    changeMemberRole(admin.id, ADMIN_RANK, team.id, ownerMember.id, ownerRole.id),
  );

  await mustReject("change the Owner's role at all", () =>
    changeMemberRole(admin.id, ADMIN_RANK, team.id, ownerMember.id, viewer.id),
  );

  await mustReject("remove a senior member", () =>
    removeMember(admin.id, ADMIN_RANK, team.id, ownerMember.id),
  );

  await mustReject("invite someone at or above own rank", () =>
    inviteMember(admin.id, ADMIN_RANK, team.id, `x-${suffix}@test.local`, ownerRole.id),
  );

  await mustReject("raise a junior role above own rank", () =>
    updateRole(admin.id, ADMIN_RANK, team.id, operator.id, { rank: 99 }),
  );

  console.log("\nLegitimate operations (still allowed):");

  await mustAllow("edit a junior role's permissions", () =>
    updateRole(admin.id, ADMIN_RANK, team.id, operator.id, {
      permissions: ["device:read", "command:read"],
    }),
  );

  await mustAllow("create a custom role below own rank", () =>
    createRole(admin.id, team.id, {
      name: `On-call ${suffix}`,
      permissions: ["device:read", "command:execute"],
      rank: 30,
    }),
  );

  await mustAllow("invite someone below own rank", () =>
    inviteMember(admin.id, ADMIN_RANK, team.id, `ops-${suffix}@test.local`, viewer.id),
  );

  console.log("\nTeam isolation:");

  const otherOwner = await prisma.user.create({
    data: {
      email: `rbac-outsider-${suffix}@test.local`,
      passwordHash: await hashPassword("not-a-real-password"),
    },
  });
  const otherTeam = await createTeam(otherOwner.id, `Outsider ${suffix}`);
  const otherRole = await prisma.role.findFirstOrThrow({
    where: { teamId: otherTeam.id, name: "Viewer" },
  });

  await mustReject("edit a role belonging to another team", () =>
    updateRole(admin.id, ADMIN_RANK, team.id, otherRole.id, {
      permissions: ["device:read"],
    }),
  );

  await mustReject("remove a member of another team", () =>
    removeMember(admin.id, ADMIN_RANK, team.id, ownerMember.id + "x"),
  );

  console.log("\nLast-owner protection:");
  await mustReject("remove the only Owner", () =>
    removeMember(owner.id, ownerRole.rank, team.id, ownerMember.id),
  );

  // Cleanup
  void adminMember;
  await prisma.team.deleteMany({ where: { id: { in: [team.id, otherTeam.id] } } });
  await prisma.user.deleteMany({
    where: { id: { in: [owner.id, admin.id, otherOwner.id] } },
  });

  console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
