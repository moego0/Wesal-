import type { PharmacyRole } from "@/generated/prisma/enums";

/**
 * Role-based access control.
 *
 * Permissions, not role strings, at every call site: `hasPermission(session,
 * "patient:write")` says what the operation requires, and a new role can be
 * introduced here without hunting for `role === "PHARMACIST"` comparisons in
 * thirty files. A missed comparison is a quiet authorization hole; a missing
 * permission entry is a compile error.
 */

export type Permission =
  | "patient:read"
  | "patient:write"
  | "patient:consent"
  | "medication:read"
  | "medication:write"
  | "schedule:read"
  | "schedule:write"
  | "followup:read"
  | "followup:write"
  | "report:read"
  | "audit:read"
  | "user:manage"
  | "settings:manage";

/** Everything a role can be granted. Used to build the role sets below. */
const ALL_PERMISSIONS: readonly Permission[] = [
  "patient:read",
  "patient:write",
  "patient:consent",
  "medication:read",
  "medication:write",
  "schedule:read",
  "schedule:write",
  "followup:read",
  "followup:write",
  "report:read",
  "audit:read",
  "user:manage",
  "settings:manage",
];

/**
 * The audit log is the only read a VIEWER cannot have: it exposes who changed
 * what for every patient in the pharmacy, which is a supervisory view, not a
 * clinical one.
 */
const VIEWER_EXCLUDED = new Set<Permission>(["audit:read"]);

/**
 * Admin-only powers. A PHARMACIST runs the clinical side of the pharmacy but
 * must not be able to grant roles, change pharmacy settings, or read the
 * audit trail — separation that matters when the audit trail is the record of
 * what the pharmacist did.
 */
const ADMIN_ONLY = new Set<Permission>(["user:manage", "settings:manage", "audit:read"]);

const PERMISSIONS_BY_ROLE: Record<PharmacyRole, ReadonlySet<Permission>> = {
  PHARMACY_ADMIN: new Set(ALL_PERMISSIONS),

  PHARMACIST: new Set(ALL_PERMISSIONS.filter((p) => !ADMIN_ONLY.has(p))),

  // Front-desk and enrollment work: registering patients, recording consent,
  // and seeing what is due — but not changing a regimen.
  ASSISTANT: new Set<Permission>([
    "patient:read",
    "patient:write",
    "patient:consent",
    "medication:read",
    "schedule:read",
    "followup:read",
  ]),

  VIEWER: new Set(
    ALL_PERMISSIONS.filter((p) => p.endsWith(":read") && !VIEWER_EXCLUDED.has(p)),
  ),
};

export function permissionsFor(role: PharmacyRole): ReadonlySet<Permission> {
  return PERMISSIONS_BY_ROLE[role];
}

/** Anything carrying a role: a session context, a membership, a bare role. */
export type RoleHolder = { role: PharmacyRole };

export function hasPermission(
  holder: RoleHolder | null | undefined,
  permission: Permission,
): boolean {
  if (!holder) return false;
  return PERMISSIONS_BY_ROLE[holder.role].has(permission);
}

export class PermissionDeniedError extends Error {
  constructor(
    readonly permission: Permission,
    readonly role: PharmacyRole,
  ) {
    super(`Role ${role} is not permitted to ${permission}`);
    this.name = "PermissionDeniedError";
  }
}

/**
 * Throws rather than returning a boolean so an unguarded code path fails
 * loudly instead of continuing with a falsy result nobody checked.
 */
export function requirePermission(holder: RoleHolder, permission: Permission): void {
  if (!hasPermission(holder, permission)) {
    throw new PermissionDeniedError(permission, holder.role);
  }
}
