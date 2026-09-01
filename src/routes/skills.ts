import { Hono } from "hono";
import DB_Skill from "../schema/skill.schema.ts";
import {
  BlockContentError,
  derivePlainText,
  normalizeDocument,
  type EditorDocument,
} from "../content/blocks.ts";
import type { AuthEnv } from "../auth/index.ts";

const skills = new Hono<AuthEnv>();

const MAX_CONTENT_BYTES = 512 * 1024;

// --- Authoring ---------------------------------------------------------------

skills.get("/admin", async (c) => {
  const size = Math.min(Number(c.req.query("size")) || 100, 200);
  const page = Math.max(Number(c.req.query("page")) || 1, 1);
  const status = c.req.query("status");

  const query: Record<string, unknown> = {};
  if (status === "published") query.isPublished = true;
  if (status === "draft") query.isPublished = false;

  const [data, totalCount] = await Promise.all([
    DB_Skill.find(query)
      .sort("group name")
      .skip((page - 1) * size)
      .limit(size),
    DB_Skill.countDocuments(query),
  ]);

  return c.json({
    data,
    meta: { size, page, totalPages: Math.ceil(totalCount / size), totalCount },
  });
});

skills.get("/admin/ids", async (c) => {
  const allSkills = await DB_Skill.find().select("_id name group isFeatured isPublished").sort("name");
  return c.json(allSkills);
});

skills.get("/admin/:id", async (c) => {
  const id = c.req.param("id");
  if (!id || id.length !== 24) return c.json({ error: "Not found" }, 404);
  const skill = await DB_Skill.findById(id);
  if (!skill) return c.json({ error: "Not found" }, 404);
  return c.json(skill);
});

// --- Public ------------------------------------------------------------------

skills.get("/", async (c) => {
  const data = await DB_Skill.find({ isPublished: true }).sort("group name");
  return c.json(data);
});

skills.get("/:id", async (c) => {
  const skillID = c.req.param("id");
  if (!skillID || skillID.length !== 24) return c.json({ error: "Not found" }, 404);
  const skill = await DB_Skill.findById(skillID);
  if (!skill) return c.json({ error: "Not found" }, 404);
  return c.json(skill);
});

skills.post("/admin", async (c) => {
  const body = await c.req.json();

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "name is required" }, 400);

  let content: EditorDocument | undefined;
  if (body.content !== undefined && body.content !== null) {
    try {
      content = parseContent(body.content);
    } catch (error) {
      if (error instanceof BlockContentError) return c.json({ error: error.message }, 400);
      throw error;
    }
  }

  let notes: unknown = body.notes;
  if (typeof notes === "object" && notes !== null && "blocks" in notes) {
    try {
      notes = parseContent(notes);
    } catch (error) {
      if (error instanceof BlockContentError) return c.json({ error: error.message }, 400);
      throw error;
    }
  }

  const plainText = content ? derivePlainText(content) : "";

  const skill = new DB_Skill({
    name,
    acquired: typeof body.acquired === "string" ? body.acquired : "",
    proficiency: typeof body.proficiency === "string" ? body.proficiency : "",
    level: Number(body.level) || 0,
    logo: typeof body.logo === "string" ? body.logo.trim() : "",
    link: typeof body.link === "string" ? body.link.trim() : "",
    group: typeof body.group === "string" && body.group ? body.group : "General",
    notes: notes ?? "",
    content,
    plainText,
    isFeatured: body.isFeatured === true,
    isPublished: body.isPublished !== false,
  });

  await skill.save();

  return c.json(skill, 201);
});

skills.put("/admin/:id", async (c) => {
  const body = await c.req.json();
  const skill = await DB_Skill.findById(c.req.param("id"));
  if (!skill) return c.json({ error: "Not found" }, 404);

  if (typeof body.name === "string" && body.name.trim()) {
    skill.name = body.name.trim();
  }
  if (typeof body.acquired === "string") skill.acquired = body.acquired;
  if (typeof body.proficiency === "string") skill.proficiency = body.proficiency;
  if (body.level !== undefined) skill.level = Number(body.level) || 0;
  if (typeof body.logo === "string") skill.logo = body.logo.trim();
  if (typeof body.link === "string") skill.link = body.link.trim();
  if (typeof body.group === "string") skill.group = body.group;
  if (typeof body.isFeatured === "boolean") skill.isFeatured = body.isFeatured;
  if (typeof body.isPublished === "boolean") skill.isPublished = body.isPublished;

  if (body.content !== undefined) {
    if (body.content === null) {
      skill.content = undefined;
    } else {
      let content: EditorDocument;
      try {
        content = parseContent(body.content);
      } catch (error) {
        if (error instanceof BlockContentError) return c.json({ error: error.message }, 400);
        throw error;
      }
      skill.content = content;
      skill.markModified("content");
      skill.plainText = derivePlainText(content);
    }
  }

  if (body.notes !== undefined) {
    let notes: unknown = body.notes;
    if (typeof notes === "object" && notes !== null && "blocks" in notes) {
      try {
        notes = parseContent(notes);
      } catch (error) {
        if (error instanceof BlockContentError) return c.json({ error: error.message }, 400);
        throw error;
      }
    }
    skill.notes = notes as any;
    skill.markModified("notes");
  }

  await skill.save();

  return c.json(skill);
});

skills.delete("/admin/:id", async (c) => {
  const skill = await DB_Skill.findByIdAndDelete(c.req.param("id"));
  if (!skill) return c.json({ error: "Not found" }, 404);

  return c.json({ deleted: skill.id });
});

// --- Helpers -----------------------------------------------------------------

function parseContent(input: unknown): EditorDocument {
  if (JSON.stringify(input ?? null).length > MAX_CONTENT_BYTES) {
    throw new BlockContentError("content exceeds maximum skill size");
  }
  return normalizeDocument(input);
}

export default skills;
