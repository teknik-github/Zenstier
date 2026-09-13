-- Grant the new `ai:use` permission to existing system roles.
--
-- Adding a permission to the catalogue only affects teams seeded afterwards;
-- roles created by an earlier version keep the permission set they were seeded
-- with. Without this, upgrading silently leaves every existing Owner unable to
-- reach a feature their role is supposed to include.
--
-- Deliberately additive: it never removes a permission, so an operator who has
-- customised Admin or Operator keeps their changes. Viewer is left alone — it
-- is the read-only role.
UPDATE roles
SET permissions = array_append(permissions, 'ai:use')
WHERE is_system = true
  AND name IN ('Owner', 'Admin', 'Operator')
  AND NOT ('ai:use' = ANY(permissions));
