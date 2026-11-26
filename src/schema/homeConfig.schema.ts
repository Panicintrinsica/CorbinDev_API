import mongoose from "mongoose";
import Atlas from "../database.ts";

/** The one home page configuration. Cards are validated by `content/home.ts`. */
const homeConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    cards: { type: [mongoose.Schema.Types.Mixed], required: true },
  },
  { timestamps: true },
);

const DB_HomeConfig = Atlas.model("homeConfig", homeConfigSchema);
export default DB_HomeConfig;
