/**
 * The real wiring behind `media/lifecycle.ts`: Mongo for the catalogue and
 * references, `media/storage.ts` for the files.
 *
 * Routes import `lifecycle` from here and call it after every write that can
 * change what is referenced.
 */

import DB_Article from "../schema/article.schema.ts";
import DB_Media from "../schema/media.schema.ts";
import DB_Profile from "../schema/profile.schema.ts";
import DB_Project from "../schema/project.schema.ts";
import DB_Skill from "../schema/skill.schema.ts";
import { createLifecycle, type Claim, type LifecyclePorts, type MediaEntry } from "./lifecycle.ts";
import { remove } from "./storage.ts";

type MediaDoc = {
  _id: unknown;
  path: string;
  claims?: Claim[];
  variants?: Array<{ path: string }>;
  originalPath?: string | null;
};

const toEntry = (doc: MediaDoc): MediaEntry => ({
  id: String(doc._id),
  path: doc.path,
  claims: (doc.claims ?? []).map(({ kind, id, slot }) => ({ kind, id, slot })),
});

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where each collection can point at an image. Block images are matched on the
 * block's `file.url`; the plain-string fields cover single-image slots and the
 * legacy markdown that predates Editor.js.
 */
const REFERENCE_FIELDS: Array<{
  model: { countDocuments(filter: object): Promise<number> };
  fields: string[];
}> = [
  { model: DB_Article, fields: ["content.blocks.data.file.url", "banner.url"] },
  { model: DB_Profile, fields: ["avatar.url"] },
  {
    model: DB_Skill,
    fields: ["content.blocks.data.file.url", "notes.blocks.data.file.url", "notes", "logo"],
  },
  {
    model: DB_Project,
    fields: ["content.blocks.data.file.url", "gallery.image.url", "thumbnail", "blurb", "details"],
  },
];

const ports: LifecyclePorts = {
  async findByPaths(paths) {
    if (paths.length === 0) return [];
    return (await DB_Media.find({ path: { $in: paths } })).map(toEntry);
  },

  async findByClaim({ kind, id, slot }) {
    const match = { kind, id, ...(slot ? { slot } : {}) };
    return (await DB_Media.find({ claims: { $elemMatch: match } })).map(toEntry);
  },

  async findStale(before, after, limit) {
    const stale = {
      $or: [
        { lastUploadedAt: { $lt: before } },
        // Records from before the field existed are judged by when they were created.
        { lastUploadedAt: { $exists: false }, createdAt: { $lt: before } },
      ],
    };
    const filter = after ? { $and: [stale, { _id: { $gt: after } }] } : stale;
    return (await DB_Media.find(filter).sort({ _id: 1 }).limit(limit)).map(toEntry);
  },

  async addClaim(id, claim) {
    await DB_Media.updateOne({ _id: id }, { $addToSet: { claims: claim } });
  },

  async countReferences(path) {
    // Suffix match: finds the file whether a block recorded an absolute URL or a
    // site-relative one, and the hash in the name makes a false positive impossible.
    const pattern = { $regex: `${escapeRegex(path)}$` };

    const counts = await Promise.all(
      REFERENCE_FIELDS.map(({ model, fields }) =>
        model.countDocuments({ $or: fields.map((field) => ({ [field]: pattern })) }),
      ),
    );
    return counts.reduce((sum, count) => sum + count, 0);
  },

  async destroy(entry) {
    const doc = await DB_Media.findById(entry.id);
    if (!doc) return;

    // Every file derived from the upload, plus the private original. `Set` because
    // the default variant's path is also listed among the variants.
    const paths = new Set<string>([
      doc.path,
      ...doc.variants.map((variant) => variant.path),
      ...(doc.originalPath ? [doc.originalPath] : []),
    ]);

    // Files first, record second: if a delete fails the record survives and the
    // next attempt retries. The other order would orphan files with no record
    // pointing at them, which nothing could ever find again.
    await Promise.all([...paths].map((path) => remove(path)));
    await doc.deleteOne();
  },
};

export const lifecycle = createLifecycle(ports);

/** Deletes a record and all its files unconditionally. The caller has already decided. */
export const destroyRecord = (id: string) => ports.destroy({ id, path: "", claims: [] });
