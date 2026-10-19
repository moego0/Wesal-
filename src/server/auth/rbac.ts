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
  | "message:read"
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
  "message:read",
  "audit:read",
  "user:manage",
  "settings:manage",
];

/**
 * The audit log and message log are reads a VIEWER cannot have: they expose supervisory
 * history, not clinical care.
 */
const VIEWER_EXCLUDED = new Set<Permission>(["audit:read", "message:read"]);

/**
 * Admin-only powers. A PHARMACIST runs the clinical side of the pharmacy but
 * must not be able to grant roles, change pharmacy settings, read the
 * audit trail, or view the message delivery log — separation that matters when
 * supervisory logs judge or record what the pharmacist did.
 */
const ADMIN_ONLY = new Set<Permission>([
  "user:manage",
  "settings:manage",
  "audit:read",
  "message:read",
]);

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
export type RoleHolder = {
  role: PharmacyRole;
  /**
   * The platform owner. Optional so a bare membership (which has no such
   * column) still satisfies the type; `true` is the only value that matters,
   * and it grants every permission without consulting the role map.
   */
  isSuperAdmin?: boolean;
};

export function hasPermission(
  holder: RoleHolder | null | undefined,
  permission: Permission,
): boolean {
  if (!holder) return false;
  // Short-circuit, not a role entry: the platform owner holds every permission
  // at every pharmacy, including ones they are not a member of. This is the
  // single place that fact is encoded.
  if (holder.isSuperAdmin === true) return true;
  return PERMISSIONS_BY_ROLE[holder.role].has(permission);
}

/**
 * The two roles a platform-created account may have. The product's vocabulary
 * calls them manager and doctor; the enum keeps the pharmacy-scoped names.
 */
export const ASSIGNABLE_ROLES: readonly PharmacyRole[] = ["PHARMACY_ADMIN", "PHARMACIST"];

export class PermissionDeniedError extends Error {
  constructor(
    readonly permission: Permission,
    readonly role: PharmacyRole,
  ) {
    super(`Role ${role} is not permitted to ${permission}`);
    this.name = "PermissionDeniedError";
  }
}

export class SuperAdminRequiredError extends Error {
  constructor() {
    super("This operation is restricted to the platform owner");
    this.name = "SuperAdminRequiredError";
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

/**
 * The platform console and the cross-tenant mutations behind it.
 *
 * Separate from the permission list on purpose: "can administer every tenant"
 * is not a permission any pharmacy role can be granted, and expressing it as
 * one would make it assignable by a future role table edit.
 */
export function requireSuperAdmin(holder: { isSuperAdmin?: boolean } | null | undefined): void {
  if (holder?.isSuperAdmin !== true) throw new SuperAdminRequiredError();
}
