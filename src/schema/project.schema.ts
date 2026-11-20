import mongoose from "mongoose";
import Atlas from "../database.ts";
import uniqueValidator from "mongoose-unique-validator";

const projectSchema = new mongoose.Schema(
  {
    uri: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    category: { type: String, required: true },
    platform: { type: String, required: true },
    link: { type: String, required: false },
    linkType: { type: String, required: false },
    blurb: { type: String, required: false },
    content: { type: mongoose.Schema.Types.Mixed, required: false },
    plainText: { type: String, required: false, select: false },
    details: { type: String, required: false },
    client: { type: String, required: false },
    role: { type: String, required: false },
    skills: [
      { type: mongoose.Schema.Types.ObjectId, ref: "skill", required: false },
    ],
    startDate: { type: String, required: false },
    endDate: { type: String, required: false },
    thumbnail: { type: String, required: false },
    /**
     * Screenshots and videos, in display order. Validated by `content/gallery.ts`:
     * `{ type: "image", caption, image: { url, width, height, variants } }` or
     * `{ type: "video", caption, videoId }` (a YouTube id).
     */
    gallery: { type: [mongoose.Schema.Types.Mixed], default: [] },
    isCurrent: { type: Boolean, default: false },
    isFeatured: { type: Boolean, default: false },
    isPublished: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  },
);

projectSchema.plugin(uniqueValidator);

const DB_Project = Atlas.model("project", projectSchema);
export default DB_Project;
