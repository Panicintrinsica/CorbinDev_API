import { Hono } from "hono";
import { BlockContentError, normalizeImageFile } from "../content/blocks.ts";
import { normalizeProfileContent } from "../content/profile.ts";
import { lifecycle } from "../media/catalog.ts";
import { dropped, referencedPaths } from "../media/lifecycle.ts";
import { toStoredPath } from "../media/storage.ts";
import DB_Media from "../schema/media.schema.ts";
import DB_Profile from "../schema/profile.schema.ts";
import { auth, PERMISSIONS } from "../auth.setup.ts";
import { getAuth, type AuthEnv } from "../auth/index.ts";

/** Narrowest source accepted for an avatar, on its shorter side; also its full size. */
export const MIN_AVATAR_SIDE = 256;
const AVATAR_PROFILE = "account/avatar";

/**
 * A person's profile, tied to their Hades account: the picture and the content of
 * the public Profile page.
 *
 *   GET  /profile      public: what the Profile page shows (the site's one profile)
 *   GET  /profile/me   the signed-in user's own profile, for editing
 *   PUT  /profile/me   save any of the fields below (absent ones are left alone)
 *
 * The picture is uploaded through `POST /media/admin` with `purpose=account/avatar`,
 * which makes the 48px and 256px renditions and refuses a source under 256px; the PUT
 * then attaches that upload to the account (or removes it with `avatar: null`).
 */
const profile = new Hono<AuthEnv>();

const FIELDS = ["avatar", "displayName", "pronouns", "birthDate", "intro", "facts", "sections"] as const;

const view = (doc: InstanceType<typeof DB_Profile> | null) =>
  Object.fromEntries(FIELDS.map((field) => [field, doc?.get(field) ?? null]));

/**
 * This site has exactly one profile, and it is pinned to one Hades account: the one
 * named by BIO_PROFILE_USER_ID, or failing that the first account that ever saved a
 * profile (the earliest, so it never moves). `null` while nobody has saved yet.
 */
async function ownerId(): Promise<string | null> {
  if (Bun.env.BIO_PROFILE_USER_ID) return Bun.env.BIO_PROFILE_USER_ID;
  const first = await DB_Profile.findOne().sort({ createdAt: 1 });
  return first?.hadesUserId ?? null;
}

/** What the page shows. Null when nothing has been saved, and the frontend then shows its built-in content. */
profile.get("/", async (c) => {
  const owner = await ownerId();
  const doc = owner ? await DB_Profile.findOne({ hadesUserId: owner }) : null;

  c.header("Cache-Control", "public, max-age=60");
  return c.json({ profile: doc ? view(doc) : null });
});

profile.get("/me", auth.requireAuth(), async (c) => {
  const { principal } = getAuth(c);
  const doc = await DB_Profile.findOne({ hadesUserId: principal.userId });
  return c.json({ userId: principal.userId, profile: doc ? view(doc) : null });
});

profile.put("/me", auth.requirePermission(PERMISSIONS.contentWrite), async (c) => {
  const { principal } = getAuth(c);

  // One profile per site: once it belongs to an account, no other account may write it.
  const owner = await ownerId();
  if (owner && owner !== principal.userId) {
    return c.json({ error: "This site's profile belongs to another account" }, 403);
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return c.json({ error: "Expected a JSON object" }, 400);

  let content: ReturnType<typeof normalizeProfileContent>;
  let avatar: ReturnType<typeof normalizeImageFile> | null | undefined;
  try {
    content = normalizeProfileContent(body);
    if ("avatar" in body) avatar = body.avatar === null ? null : await checkedAvatar(body.avatar);
  } catch (error) {
    if (error instanceof BlockContentError) return c.json({ error: error.message }, 400);
    throw error;
  }

  const doc =
    (await DB_Profile.findOne({ hadesUserId: principal.userId })) ??
    new DB_Profile({ hadesUserId: principal.userId });

  const before = referencedPaths(doc);
  doc.set(content);
  if (avatar !== undefined) {
    doc.avatar = avatar ?? undefined;
    doc.markModified("avatar");
  }
  await doc.save();

  // A picture this save replaced is deleted unless something else still uses it.
  await lifecycle.release(dropped(before, referencedPaths(doc)));

  return c.json({ userId: principal.userId, profile: view(doc) });
});

/**
 * An avatar must be one of our own uploads made for this purpose, not any URL a
 * client names: it is shown on a public page, so it is checked against the media
 * catalogue rather than trusted.
 */
async function checkedAvatar(input: unknown) {
  const image = normalizeImageFile(input, "avatar");

  const path = toStoredPath(image.url);
  const record = path ? await DB_Media.findOne({ path }) : null;
  if (!record || record.profile !== AVATAR_PROFILE) {
    throw new BlockContentError("Upload the picture as a profile image first");
  }
  if (!record.width || record.width < MIN_AVATAR_SIDE) {
    throw new BlockContentError(`The picture must be at least ${MIN_AVATAR_SIDE}px`);
  }

  // Trust the catalogue's record of the files, not the client's description of them.
  return normalizeImageFile(
    {
      url: image.url,
      width: record.width,
      height: record.height,
      variants: (record.variants ?? []).map((variant) => ({
        format: variant.format,
        width: variant.width,
        url: image.url.replace(path!, variant.path),
      })),
    },
    "avatar",
  );
}

export default profile;
