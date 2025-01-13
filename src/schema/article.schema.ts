import mongoose from "mongoose";
import Atlas from "../database.ts";

const articleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    date: { type: String, required: true },
    uri: { type: String, required: true },
    aboveFold: { type: String, required: true },
    belowFold: { type: String, required: true },
    category: { type: String, required: true },
    tags: { type: [String], required: true },
    author: { type: String, required: true },
    isPublished: { type: Boolean, required: true },
  },
  {
    timestamps: true,
  },
);

const DB_Article = Atlas.model("article", articleSchema);
export default DB_Article;
