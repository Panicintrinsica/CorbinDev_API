import mongoose from "mongoose";
import Atlas from "../database.ts";

const contentBlockSchema = new mongoose.Schema({
  page: { type: String, required: true },
  uri: { type: String, required: true },
  title: { type: String, required: true },
  body: { type: String, required: true },
});

const DB_ContentBlock = Atlas.model("contentBlock", contentBlockSchema);
export default DB_ContentBlock;
