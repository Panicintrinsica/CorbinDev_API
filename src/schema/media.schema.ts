import mongoose from "mongoose";
import Atlas from "../database.ts";

/**
 * The catalogue of uploaded files. The bytes live on disk (see `media/storage.ts`);
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
    /** Absent for formats whose header we do not decode; the renderer copes. */
    width: { type: Number },
    height: { type: Number },
    /** What the author called it on their machine. Display only — never a path. */
    originalName: { type: String, default: "" },
    /** Default alt text, offered to the editor when the image is reused. */
    alt: { type: String, default: "" },
    /** Hades `sub` of the uploader. */
    uploadedBy: { type: String, required: true, index: true },
  },
  {
    timestamps: true,
  },
);

const DB_Media = Atlas.model("media", mediaSchema);
export default DB_Media;
