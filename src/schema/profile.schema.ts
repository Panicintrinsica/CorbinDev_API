import mongoose from "mongoose";
import Atlas from "../database.ts";

/**
 * What this site keeps about a person beyond their Hades identity and their
 * account (`auth_accounts`): their profile picture and the content of the public
 * Profile page.
 *
 * Keyed by the Hades `sub` (the same id as `auth_principals`), so it follows the
 * account without touching the auth module's own collections. Content fields are
 * validated by `content/profile.ts`; a field that was never saved is simply absent,
 * and the frontend shows its built-in default for it.
 */
const profileSchema = new mongoose.Schema(
  {
    hadesUserId: { type: String, required: true, unique: true },
    /**
     * `{ url, width, height, variants }` — a 48px and a 256px AVIF, both square.
     * Validated by `routes/profile.ts` against the media catalogue before it is stored.
     */
    avatar: { type: mongoose.Schema.Types.Mixed, required: false },

    displayName: { type: String, required: false },
    pronouns: { type: String, required: false },
    birthDate: { type: String, required: false },
    /** Markdown. */
    intro: { type: String, required: false },
    facts: { type: [mongoose.Schema.Types.Mixed], required: false, default: undefined },
    sections: { type: [mongoose.Schema.Types.Mixed], required: false, default: undefined },
  },
  { timestamps: true },
);

const DB_Profile = Atlas.model("profile", profileSchema);
export default DB_Profile;
