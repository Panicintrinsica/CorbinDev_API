import mongoose from "mongoose";
import Atlas from "../database.ts";
import uniqueValidator from "mongoose-unique-validator";

const skillSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    acquired: { type: String, required: true },
    proficiency: { type: String, required: true },
    level: { type: Number, required: true },
    logo: { type: String, required: true },
    link: { type: String, required: true },
    group: { type: String, required: true },
    notes: { type: String, required: true },
    isFeatured: { type: Boolean, required: true },
    isPublished: { type: Boolean, required: true },
  },
  {
    timestamps: true,
  },
);

skillSchema.plugin(uniqueValidator);

const DB_Skill = Atlas.model("skill", skillSchema);
export default DB_Skill;
