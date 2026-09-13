/*
  Warnings:

  - Made the column `team_id` on table `auth_tokens` required. This step will fail if there are existing NULL values in that column.
  - Made the column `team_id` on table `command_batches` required. This step will fail if there are existing NULL values in that column.
  - Made the column `team_id` on table `command_history` required. This step will fail if there are existing NULL values in that column.
  - Made the column `team_id` on table `device_groups` required. This step will fail if there are existing NULL values in that column.
  - Made the column `team_id` on table `devices` required. This step will fail if there are existing NULL values in that column.

*/
-- ---------------------------------------------------------------------------
-- Backfill (idempotent): give any pre-teams data an owning team.
--
-- Without this, adding NOT NULL below fails on any database that already holds
-- devices or command history from before teams existed. Every user with
-- orphaned rows gets a personal team seeded with the four system roles, is
-- made its Owner, and their rows are moved onto it.
-- ---------------------------------------------------------------------------

DO $backfill$
DECLARE
  u        RECORD;
  new_team TEXT;
BEGIN
  FOR u IN
    SELECT DISTINCT us.id, us.email, us.name
    FROM users us
    WHERE EXISTS (SELECT 1 FROM devices d         WHERE d.user_id = us.id AND d.team_id IS NULL)
       OR EXISTS (SELECT 1 FROM device_groups g   WHERE g.user_id = us.id AND g.team_id IS NULL)
       OR EXISTS (SELECT 1 FROM auth_tokens t     WHERE t.user_id = us.id AND t.team_id IS NULL)
       OR EXISTS (SELECT 1 FROM command_batches b WHERE b.user_id = us.id AND b.team_id IS NULL)
       OR EXISTS (SELECT 1 FROM command_history c WHERE c.user_id = us.id AND c.team_id IS NULL)
  LOOP
    -- Reuse an existing membership when the user already belongs to a team.
    SELECT m.team_id INTO new_team
    FROM team_members m WHERE m.user_id = u.id
    ORDER BY m.joined_at ASC LIMIT 1;

    IF new_team IS NULL THEN
      new_team := 'bf' || replace(gen_random_uuid()::text, '-', '');

      INSERT INTO teams (id, name, slug, is_personal, created_at, updated_at)
      VALUES (
        new_team,
        concat(coalesce(nullif(u.name, ''), split_part(u.email, '@', 1)), ' team'),
        concat('team-', substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
        true, now(), now()
      );

      INSERT INTO roles (id, team_id, name, description, permissions, is_system, rank, created_at, updated_at)
      VALUES
        (concat(new_team, '_owner'), new_team, 'Owner',
         'Full control, including team settings and membership.',
         ARRAY['device:read','device:create','device:update','device:delete','device:revoke',
               'command:read','command:execute','audit:read','team:read',
               'team:manage_members','team:manage_roles','team:manage_settings'],
         true, 100, now(), now()),
        (concat(new_team, '_admin'), new_team, 'Admin',
         'Manages devices, members and roles, but not team settings.',
         ARRAY['device:read','device:create','device:update','device:delete','device:revoke',
               'command:read','command:execute','audit:read','team:read',
               'team:manage_members','team:manage_roles'],
         true, 80, now(), now()),
        (concat(new_team, '_operator'), new_team, 'Operator',
         'Runs commands and enrolls devices. Cannot manage the team.',
         ARRAY['device:read','device:create','device:update','command:read',
               'command:execute','audit:read','team:read'],
         true, 50, now(), now()),
        (concat(new_team, '_viewer'), new_team, 'Viewer',
         'Read-only access to devices, history and the audit log.',
         ARRAY['device:read','command:read','audit:read','team:read'],
         true, 10, now(), now());

      INSERT INTO team_members (id, team_id, user_id, role_id, joined_at)
      VALUES (concat(new_team, '_m'), new_team, u.id, concat(new_team, '_owner'), now());

      UPDATE users SET active_team_id = new_team
      WHERE id = u.id AND active_team_id IS NULL;
    END IF;

    UPDATE devices         SET team_id = new_team WHERE user_id = u.id AND team_id IS NULL;
    UPDATE device_groups   SET team_id = new_team WHERE user_id = u.id AND team_id IS NULL;
    UPDATE auth_tokens     SET team_id = new_team WHERE user_id = u.id AND team_id IS NULL;
    UPDATE command_batches SET team_id = new_team WHERE user_id = u.id AND team_id IS NULL;
    UPDATE command_history SET team_id = new_team WHERE user_id = u.id AND team_id IS NULL;
    UPDATE audit_logs      SET team_id = new_team WHERE user_id = u.id AND team_id IS NULL;
  END LOOP;
END
$backfill$;

-- DropForeignKey
ALTER TABLE "devices" DROP CONSTRAINT "devices_team_id_fkey";

-- AlterTable
ALTER TABLE "auth_tokens" ALTER COLUMN "team_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "command_batches" ALTER COLUMN "team_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "command_history" ALTER COLUMN "team_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "device_groups" ALTER COLUMN "team_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "devices" ALTER COLUMN "team_id" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
