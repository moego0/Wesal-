-- Platform owner flag. Existing accounts keep their pharmacy memberships and
-- gain nothing by default; the flag is granted explicitly (see
-- scripts/grant-super-admin.ts) or by the production bootstrap.
ALTER TABLE "User" ADD COLUMN "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false;
