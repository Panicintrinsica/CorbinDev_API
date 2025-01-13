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
    blurb: { type: String, required: true },
    details: { type: String, required: false },
    client: { type: String, required: false },
    role: { type: String, required: true },
    skills: [
      { type: mongoose.Schema.Types.ObjectId, ref: "skill", required: false },
    ],
    startDate: { type: String, required: true },
    endDate: { type: String, required: false },
    thumbnail: { type: String, required: false },
    isCurrent: { type: Boolean, required: true },
    isFeatured: { type: Boolean, required: true },
    isPublished: { type: Boolean, required: true },
  },
  {
    timestamps: true,
  },
);

projectSchema.plugin(uniqueValidator);

const DB_Project = Atlas.model("project", projectSchema);
export default DB_Project;
