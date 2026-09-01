import type { Principal, RoleDefinition } from "./types.ts";

/**
 * The authorization engine. Pure functions over plain data — no I/O, no framework.
 * This is the part Hades explicitly does not own: "per-application permissions are
 * the relying application's concern" (docs/agent/architecture.md).
 *
 * Permission grammar
 * ------------------
 *   segment[:segment...]     e.g. "articles:write"
 *   "*"                      matches everything
 *   "articles:*"             matches every permission under "articles"
 *
 * Wildcards are only honoured on the GRANT side. A requirement is always literal,
 * so `require("*")` asks for a permission named `*` and nothing implicit.
 */

export const WILDCARD = "*";

export function resolvePermissions(
  principal: Pick<Principal, "roles" | "directPermissions" | "deniedPermissions">,
  roleDefinitions: RoleDefinition[],
): Set<string> {
  const byName = new Map(roleDefinitions.map((r) => [r.name, r]));
  const granted = new Set<string>();

  for (const roleName of principal.roles) {
    const role = byName.get(roleName);
    if (!role) continue; // An unknown role grants nothing. Never fail open on a typo.
    for (const permission of role.permissions) granted.add(permission);
  }
  for (const permission of principal.directPermissions) granted.add(permission);

  // Denials are applied last and are literal: denying "articles:*" removes that
  // wildcard grant, not every permission it would have matched. Deny the exact
  // strings you mean.
  for (const permission of principal.deniedPermissions) granted.delete(permission);

  return granted;
}

/** True when `granted` (which may contain wildcards) satisfies `required`. */
export function permits(granted: ReadonlySet<string>, required: string): boolean {
  if (granted.has(WILDCARD)) return true;
  if (granted.has(required)) return true;

  const segments = required.split(":");
  // "a:b:c" is satisfied by "a:*" or "a:b:*".
  for (let i = segments.length - 1; i > 0; i--) {
    if (granted.has(`${segments.slice(0, i).join(":")}:${WILDCARD}`)) return true;
  }
  return false;
}

export function permitsAll(granted: ReadonlySet<string>, required: string[]): boolean {
  return required.every((permission) => permits(granted, permission));
}

export function permitsAny(granted: ReadonlySet<string>, required: string[]): boolean {
  return required.some((permission) => permits(granted, permission));
}

/**
 * A requirement expressed declaratively so route definitions stay data, not code.
 * `allOf` and `anyOf` are both checked when both are given.
 */
export interface PermissionRequirement {
  allOf?: string[];
  anyOf?: string[];
  /** Hades global roles (token `scope`) that satisfy this outright, e.g. g_superadmin. */
  globalRoles?: string[];
}

export function satisfies(
  requirement: PermissionRequirement,
  granted: ReadonlySet<string>,
  globalRoles: string[],
): boolean {
  const wantsGlobalRole = (requirement.globalRoles?.length ?? 0) > 0;
  const wantsPermission =
    (requirement.allOf?.length ?? 0) > 0 || (requirement.anyOf?.length ?? 0) > 0;

  // An empty requirement means "authenticated is enough".
  if (!wantsGlobalRole && !wantsPermission) return true;

  // A Hades global role is an escape hatch that satisfies the whole requirement —
  // that is what g_superadmin is for. It is checked first and never ANDed.
  if (wantsGlobalRole && requirement.globalRoles!.some((role) => globalRoles.includes(role))) {
    return true;
  }
  // Only a global role was asked for, and the token does not carry one.
  if (!wantsPermission) return false;

  if (requirement.allOf && !permitsAll(granted, requirement.allOf)) return false;
  if (requirement.anyOf && !permitsAny(granted, requirement.anyOf)) return false;
  return true;
}
