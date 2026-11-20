import mongoose from "mongoose";
import Atlas from "../database.ts";

/**
 * The catalogue of uploaded files. The bytes live in storage (see `media/storage.ts`);
 * this is the index over them, and the only thing that knows an upload's original
 * filename, who made it, or what it is used for.
 *
 * Keeping metadata here rather than inferring it from the filesystem is what makes
 * a media library screen — list, search, delete, "what is this file?" — possible
 * without walking directories.
 */
const mediaSchema = new mongoose.Schema(
  {
    /** Site-relative stored path, `/media/2026/08/<hash>.webp`. The public identity of the file. */
    path: { type: String, required: true, unique: true, index: true },
    /** Full SHA-256 of the bytes, so a re-upload is recognised instead of duplicated. */
    hash: { type: String, required: true, index: true },
    mimeType: { type: String, required: true },
    bytes: { type: Number, required: true },
    /** Post-rotation size of the image as authored. Absent only on pre-processing records. */
    width: { type: Number },
    height: { type: Number },
    /**
     * Which processing profile produced the variants (see `PROFILES`), or "svg".
     * Identical bytes uploaded for different purposes are different sets of files,
     * so a re-upload is only recognised within the same profile. Absent = "default".
     */
    profile: { type: String },
    /** True for multi-frame GIF/WebP; those have WebP variants only. */
    animated: { type: Boolean, default: false },
    /**
     * The responsive set generated at upload. `path` above is the default `<img src>`
     * and is also listed here. Empty on records from before image processing, which
     * are served as the single file they always were.
     */
    variants: {
      type: [
        new mongoose.Schema(
          {
            format: { type: String, enum: ["avif", "webp"], required: true },
            width: { type: Number, required: true },
            height: { type: Number, required: true },
            bytes: { type: Number, required: true },
            path: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /**
     * The upload exactly as received, kept privately so variants can be regenerated
     * (new widths, a new format) without asking the author to re-upload. Never served.
     */
    originalPath: { type: String },
    originalMimeType: { type: String },
    /** What the author called it on their machine. Display only — never a path. */
    originalName: { type: String, default: "" },
    /** Default alt text, offered to the editor when the image is reused. */
    alt: { type: String, default: "" },
    /** Hades `sub` of the uploader. */
    uploadedBy: { type: String, required: true, index: true },
    /**
     * What this file was uploaded *for*, e.g. `{ kind: "skill", id, slot: "logo" }`.
     * A list because identical bytes are one file (content-addressed), so the same
     * image can legitimately be claimed by several owners. Used to replace a
     * single-image slot and to clean up when its owner is deleted; whether the file
     * may be deleted is always decided by references, never by claims alone.
     */
    claims: {
      type: [
        new mongoose.Schema(
          {
            kind: { type: String, enum: ["article", "skill", "project"], required: true },
            id: { type: String, required: true },
            slot: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /**
     * When this was last uploaded (a re-upload of the same bytes counts). The
     * orphan sweep measures its grace period from here, so an image being re-used
     * is never mistaken for an abandoned one.
     */
    lastUploadedAt: { type: Date, default: () => new Date() },
  },
  {
    timestamps: true,
  },
);

mediaSchema.index({ "claims.kind": 1, "claims.id": 1 });
mediaSchema.index({ lastUploadedAt: 1 });

const DB_Media =Atlas.model("media", mediaSchema);
export default DB_Media;
