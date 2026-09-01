import mongoose from "mongoose";
import Atlas from "../database.ts";

/**
 * An article body is an Editor.js document — an ordered list of typed blocks —
 * rather than the two markdown strings this collection used to hold.
 *
 * `excerpt` and `plainText` are both derived from `content` on every write and are
 * never authored directly through the API's own derivation path. They exist
 * because the two things a body is needed for besides rendering — a summary on a
 * card, and a search index — should not require every reader to parse the block
 * tree:
 *
 *   excerpt    short prose for article cards, search results and <meta description>
 *   plainText  the whole body flattened, so Atlas Search indexes one text field
 *              instead of reaching into an array whose shape changes whenever a
 *              new block tool is added
 */
const articleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    /** DD-MM-YY, and half of the public URL. Fixed at creation so links do not rot. */
    date: { type: String, required: true },
    /** Slug, and the other half of the public URL. Also fixed at creation. */
    uri: { type: String, required: true },

    /** Editor.js OutputData: `{ time, version, blocks: [...] }`. Sanitized on write. */
    content: { type: mongoose.Schema.Types.Mixed, required: true },
    excerpt: { type: String, required: true },
    /**
     * Excluded from queries by default — it is a duplicate of the body and would
     * otherwise double the size of every list response. Atlas Search reads it
     * through the aggregation pipeline, which is not bound by this.
     */
    plainText: { type: String, required: true, select: false },

    category: { type: String, required: true },
    tags: { type: [String], required: true },
    author: { type: String, required: true },
    isPublished: { type: Boolean, required: true },
  },
  {
    timestamps: true,
  },
);

// The public article lookup: /blog/a/:date/:uri resolves through exactly this.
articleSchema.index({ date: 1, uri: 1 }, { unique: true });
// The blog index and its category filter, in the order the page query sorts.
articleSchema.index({ isPublished: 1, category: 1, createdAt: -1 });

const DB_Article = Atlas.model("article", articleSchema);
export default DB_Article;
