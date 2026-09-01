import mongoose from "mongoose";
import Atlas from "../database.ts";
import uniqueValidator from "mongoose-unique-validator";

const skillSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    acquired: { type: String, required: false },
    proficiency: { type: String, required: false },
    level: { type: Number, required: false, default: 0 },
    logo: { type: String, required: false },
    link: { type: String, required: false },
    group: { type: String, required: false, default: "General" },
    notes: { type: mongoose.Schema.Types.Mixed, required: false },
    content: { type: mongoose.Schema.Types.Mixed, required: false },
    plainText: { type: String, required: false, select: false },
    isFeatured: { type: Boolean, default: false },
    isPublished: { type: Boolean, default: true },
  },
  {
    timestamps: true,
  },
);

skillSchema.plugin(uniqueValidator);

const DB_Skill = Atlas.model("skill", skillSchema);
export default DB_Skill;
