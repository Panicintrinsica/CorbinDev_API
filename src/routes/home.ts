import { Hono } from "hono";
import { BlockContentError } from "../content/blocks.ts";
import { normalizeHomeCards, type HomeCard } from "../content/home.ts";
import { lifecycle } from "../media/catalog.ts";
import { dropped, referencedPaths } from "../media/lifecycle.ts";
import DB_HomeConfig from "../schema/homeConfig.schema.ts";
import DB_Skill from "../schema/skill.schema.ts";
import type { AuthEnv } from "../auth/index.ts";

/**
 * The home page's feature cards.
 *
 *   GET /home        public: cards with their published skills filled in
 *   GET /home/admin  cards as stored (skill ids), for editing
 *   PUT /home/admin  replace the cards
 *
 * `config` is null until something has been saved, and the frontend then shows its
 * built-in cards. `/home/admin` is permission-gated in `index.ts`.
 */
const home = new Hono<AuthEnv>();

const KEY = "home";

const stored = async (): Promise<HomeCard[] | null> => {
  const doc = await DB_HomeConfig.findOne({ key: KEY });
  return doc ? (doc.toObject().cards as HomeCard[]) : null;
};

home.get("/", async (c) => {
  const cards = await stored();
  if (!cards) return c.json({ config: null });

  const skills = await DB_Skill.find({
    _id: { $in: cards.flatMap((card) => card.skills) },
    isPublished: true,
  }).select("name logo");
  const byId = new Map(skills.map((skill) => [String(skill._id), skill]));

  return c.json({
    config: {
      cards: cards.map((card) => ({
        ...card,
        // Card order, not query order; deleted and draft skills drop out.
        skills: card.skills.flatMap((id) => byId.get(id) ?? []),
      })),
    },
  });
});

home.get("/admin", async (c) => {
  const cards = await stored();
  return c.json({ config: cards ? { cards } : null });
});

home.put("/admin", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { cards?: unknown } | null;

  let cards: HomeCard[];
  try {
    cards = normalizeHomeCards(body?.cards);
  } catch (error) {
    if (error instanceof BlockContentError) return c.json({ error: error.message }, 400);
    throw error;
  }

  const doc =
    (await DB_HomeConfig.findOne({ key: KEY })) ?? new DB_HomeConfig({ key: KEY, cards: [] });
  const before = referencedPaths(doc);
  doc.set({ cards });
  doc.markModified("cards");
  await doc.save();

  // Pictures this save removed are deleted unless something else still uses them.
  await lifecycle.release(dropped(before, referencedPaths(doc)));

  return c.json({ config: { cards } });
});

export default home;
