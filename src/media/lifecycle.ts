/**
 * Keeps storage from filling with files nothing uses.
 *
 * Uploads are content-addressed, so two articles that use the same picture share
 * one file. That rules out "an image belongs to whoever uploaded it": deleting
 * article A's images would break article B. Instead, **references are the source
 * of truth** — a file may be deleted exactly when nothing in the catalogue points
 * at it — and everything here is a way of asking that question at the right
 * moment:
 *
 *   release      something stopped referencing these files (a save dropped an
 *                image, a record was deleted): delete each one nothing else uses.
 *   claim        an upload says what it is *for* — `skill:<id>/logo`. A slot that
 *                holds one image (a logo) supersedes: uploading a replacement
 *                immediately deletes earlier unreferenced uploads for that slot,
 *                so trying ten icons leaves one, not ten.
 *   sweep        uploads that were never attached to anything (an abandoned
 *                draft, a closed tab) are deleted once they are older than a grace
 *                period. The grace period is not optional: Editor.js uploads an
 *                image the moment it is inserted, long before the article is first
 *                saved, so "unreferenced" is the normal state of an image being
 *                authored.
 *
 * The logic is written against `LifecyclePorts` so the decisions that delete files
 * can be tested without a database. `media/catalog.ts` is the real wiring.
 */

import { toStoredPath } from "./storage.ts";

export type OwnerKind = "article" | "skill" | "project";

/** What an upload is for. `slot` names the field, e.g. `logo` or `thumbnail`. */
export interface Claim {
  kind: OwnerKind;
  id: string;
  slot: string;
}

/**
 * Slots that hold exactly one image, so a new upload replaces the old one. Anything
 * not listed (an article body) holds many and is never superseded.
 *
 * Also the allow-list of what a client may claim.
 */
export const SLOTS: Record<OwnerKind, { single: string[]; multiple: string[] }> = {
  article: { single: ["banner"], multiple: ["body"] },
  skill: { single: ["logo"], multiple: ["body"] },
  project: { single: ["thumbnail"], multiple: ["body", "gallery"] },
};

export function isValidClaim(claim: Claim): boolean {
  const slots = SLOTS[claim.kind];
  return (
    Boolean(slots) &&
    /^[0-9a-f]{24}$/.test(claim.id) &&
    (slots.single.includes(claim.slot) || slots.multiple.includes(claim.slot))
  );
}

export interface MediaEntry {
  id: string;
  /** The default `<img src>` path; what blocks and fields reference. */
  path: string;
  claims: Claim[];
}

export interface LifecyclePorts {
  findByPaths(paths: string[]): Promise<MediaEntry[]>;
  findByClaim(match: { kind: OwnerKind; id: string; slot?: string }): Promise<MediaEntry[]>;
  /** Entries last uploaded before `before`, in a stable order, `after` being the last id seen. */
  findStale(before: Date, after: string | null, limit: number): Promise<MediaEntry[]>;
  addClaim(id: string, claim: Claim): Promise<void>;
  /** How many catalogue documents (articles, skills, projects) still point at `path`. */
  countReferences(path: string): Promise<number>;
  /** Deletes every stored file for the entry and its catalogue record. */
  destroy(entry: MediaEntry): Promise<void>;
}

export interface SweepResult {
  scanned: number;
  deleted: string[];
  dryRun: boolean;
}

type Log = Pick<Console, "warn" | "info">;

export function createLifecycle(ports: LifecyclePorts, log: Log = console) {
  /** Deletes the entries nothing references. Returns the paths it deleted. */
  async function deleteUnreferenced(entries: MediaEntry[], dryRun = false): Promise<string[]> {
    const deleted: string[] = [];

    for (const entry of entries) {
      try {
        // Checked per entry, immediately before deleting, so a reference added by
        // a concurrent save while this ran is still honoured.
        if ((await ports.countReferences(entry.path)) > 0) continue;
        if (!dryRun) await ports.destroy(entry);
        deleted.push(entry.path);
      } catch (error) {
        // Never delete on doubt: a failed reference check skips the file, and the
        // sweep will look at it again. Never fail the caller's save over it either.
        log.warn(`[media] could not clean up ${entry.path}:`, error);
      }
    }

    return deleted;
  }

  /**
   * Cleanup runs after the caller's own write has already succeeded, so a failure
   * here (the database blipping mid-lookup) is logged and left for the sweep, not
   * turned into an error response for a save that worked.
   */
  async function quietly(what: string, run: () => Promise<string[]>): Promise<string[]> {
    try {
      return await run();
    } catch (error) {
      log.warn(`[media] ${what} failed; the sweep will retry:`, error);
      return [];
    }
  }

  return {
    /** Something stopped referencing `paths`; delete each one that is now unused. */
    async release(paths: Iterable<string>): Promise<string[]> {
      const wanted = [...new Set(paths)];
      if (wanted.length === 0) return [];
      return quietly("release", async () => deleteUnreferenced(await ports.findByPaths(wanted)));
    },

    /**
     * A record (article, skill, project) was deleted. `referenced` is what it
     * pointed at; its own claims cover uploads it never ended up pointing at.
     */
    async releaseOwner(
      kind: OwnerKind,
      id: string,
      referenced: Iterable<string> = [],
    ): Promise<string[]> {
      return quietly("releaseOwner", async () => {
        const [byPath, byClaim] = await Promise.all([
          ports.findByPaths([...new Set(referenced)]),
          ports.findByClaim({ kind, id }),
        ]);

        const unique = new Map<string, MediaEntry>();
        for (const entry of [...byPath, ...byClaim]) unique.set(entry.id, entry);

        return deleteUnreferenced([...unique.values()]);
      });
    },

    /**
     * Records what an upload is for and, for a single-image slot, drops the earlier
     * uploads it replaces. Replaced uploads that are still referenced (the image
     * the record currently shows) are kept until a save actually switches over —
     * the save's own `release` then removes them.
     */
    async claim(entry: MediaEntry, claim: Claim): Promise<string[]> {
      if (!entry.claims.some((existing) => sameClaim(existing, claim))) {
        await ports.addClaim(entry.id, claim);
      }

      if (!SLOTS[claim.kind].single.includes(claim.slot)) return [];

      const earlier = (await ports.findByClaim(claim)).filter((other) => other.id !== entry.id);
      return deleteUnreferenced(earlier);
    },

    /** Deletes uploads nothing references that were last touched before `now - graceMs`. */
    async sweep(options: { graceMs: number; now?: Date; dryRun?: boolean }): Promise<SweepResult> {
      const before = new Date((options.now ?? new Date()).getTime() - options.graceMs);
      const result: SweepResult = { scanned: 0, deleted: [], dryRun: options.dryRun === true };

      let after: string | null = null;
      for (;;) {
        const page = await ports.findStale(before, after, 100);
        if (page.length === 0) break;

        result.scanned += page.length;
        result.deleted.push(...(await deleteUnreferenced(page, result.dryRun)));
        after = page[page.length - 1]!.id;
      }

      return result;
    },

    /** How many documents reference `path`; the delete route refuses when it is above zero. */
    countReferences: (path: string) => ports.countReferences(path),
  };
}

export type Lifecycle = ReturnType<typeof createLifecycle>;

function sameClaim(a: Claim, b: Claim): boolean {
  return a.kind === b.kind && a.id === b.id && a.slot === b.slot;
}

// --- What a document references -----------------------------------------------

/**
 * Every served-media path an entity points at: image blocks in `content` and
 * `notes`, plus single-image fields.
 *
 * Deliberately tolerant of shape. It runs against whatever is stored — a Mixed
 * field may hold an Editor.js document, a legacy string, or nothing — and must
 * never throw, because it sits on the path of every save.
 */
export function referencedPaths(entity: {
  content?: unknown;
  notes?: unknown;
  logo?: unknown;
  thumbnail?: unknown;
  gallery?: unknown;
  banner?: unknown;
  avatar?: unknown;
}): Set<string> {
  const paths = new Set<string>();

  for (const doc of [entity.content, entity.notes]) {
    for (const url of imageUrlsIn(doc)) addPath(paths, url);
  }
  for (const image of [entity.banner, entity.avatar]) {
    const url = (image as { url?: unknown } | null | undefined)?.url;
    if (typeof url === "string") addPath(paths, url);
  }

  if (Array.isArray(entity.gallery)) {
    for (const item of entity.gallery) {
      const url = item?.image?.url;
      if (typeof url === "string") addPath(paths, url);
    }
  }
  for (const field of [entity.logo, entity.thumbnail]) {
    if (typeof field === "string") addPath(paths, field);
  }

  return paths;
}

/** Paths in `before` that are not in `after`: what a save just stopped using. */
export function dropped(before: Set<string>, after: Set<string>): string[] {
  return [...before].filter((path) => !after.has(path));
}

function imageUrlsIn(doc: unknown): string[] {
  const blocks = (doc as { blocks?: unknown } | null | undefined)?.blocks;
  if (!Array.isArray(blocks)) return [];

  const urls: string[] = [];
  for (const block of blocks) {
    if (block?.type !== "image") continue;
    const url = block.data?.file?.url;
    if (typeof url === "string") urls.push(url);
  }
  return urls;
}

function addPath(into: Set<string>, url: string): void {
  const path = toStoredPath(url.trim());
  // Only served media counts. `originals/` is private and never referenced by content.
  if (path?.startsWith("/media/")) into.add(path);
}
