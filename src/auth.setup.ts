import Atlas from "./database.ts";
import { createHadesAuth } from "./auth/index.ts";
import type { RoleDefinition } from "./auth/index.ts";

/**
 * corbin.dev's own authorization policy. This is the only file that should need
 * editing when a new capability is added — `src/auth/` stays generic.
 *
 * Permission naming: `<resource>:<action>`, and a grant may end in `*`.
 */
export const PERMISSIONS = {
  articlesWrite: "articles:write",
  projectsWrite: "projects:write",
  skillsWrite: "skills:write",
  contentWrite: "content:write",
  mediaWrite: "media:write",
} as const;

/**
 * Seeded on boot only when the role does not already exist, so a permission edited
 * in the database survives a deploy.
 */
export const ROLES: RoleDefinition[] = [
  {
    name: "member",
    permissions: [],
    description: "Any authenticated Hades account. Public data needs no permission.",
    isDefault: true,
  },
  {
    name: "editor",
    permissions: ["articles:*", "projects:*", "skills:*", "content:*", "media:*"],
    description: "Can create and edit site content.",
    isDefault: false,
  },
  {
    name: "owner",
    permissions: ["*", "auth:principals:*", "auth:roles:*"],
    description: "Full control, including who else may do what.",
    isDefault: false,
  },
];

export const auth = createHadesAuth({
  connection: Atlas,
  seedRoles: ROLES,
});
