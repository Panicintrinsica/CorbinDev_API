import { Hono } from "hono";
import DB_Project from "../schema/project.schema.ts";
import DB_Skill from "../schema/skill.schema.ts";
import { createURI } from "../util.ts";
import {
  BlockContentError,
  deriveExcerpt,
  derivePlainText,
  normalizeDocument,
  type EditorDocument,
} from "../content/blocks.ts";
import type { AuthEnv } from "../auth/index.ts";

const projects = new Hono<AuthEnv>();

const CARD_FIELDS =
  "uri name category platform link linkType blurb thumbnail isFeatured isCurrent isPublished startDate endDate skills createdAt updatedAt";

const MAX_CONTENT_BYTES = 512 * 1024;

// --- Public ------------------------------------------------------------------

/**
 * Gets a list of public projects
 */
projects.get("/", async (c) => {
  const data = await DB_Project.find(
    { isPublished: true },
    CARD_FIELDS,
  )
    .populate({
      path: "skills",
      select: "name group isFeatured isPublished",
    })
    .sort("-isCurrent -endDate -createdAt");

  return c.json(data);
});

projects.get("/byURI/:uri", async (c) => {
  const uri = c.req.param("uri");

  const projectDetails = await DB_Project.findOne({
    uri: uri,
    isPublished: true,
  }).populate({
    path: "skills",
    select: "name group logo level isFeatured isPublished",
  });

  if (!projectDetails) return c.json({ error: "Not found" }, 404);

  return c.json(projectDetails);
});

projects.get("/bySkill/:id", async (c) => {
  const skillId = c.req.param("id");

  const projectDetails = await DB_Project.find(
    { skills: skillId, isPublished: true },
    "-_id name uri category",
  );
  return c.json(projectDetails);
});

// --- Authoring ---------------------------------------------------------------

/** Every project including drafts, newest first. Supports search, category/platform filtering, and pagination. */
projects.get("/admin", async (c) => {
  const size = Math.min(Number(c.req.query("size")) || 25, 100);
  const page = Math.max(Number(c.req.query("page")) || 1, 1);
  const status = c.req.query("status");
  const category = c.req.query("category");
  const categories = c.req.queries("categories");
  const platform = c.req.query("platform");
  const search = c.req.query("search") || c.req.query("q");
  const name = c.req.query("name");

  const query: Record<string, unknown> = {};
  if (status === "published") query.isPublished = true;
  if (status === "draft") query.isPublished = false;

  if (category && category !== "all") {
    const escapedCategory = category.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.category = { $regex: new RegExp(`^${escapedCategory}$`, "i") };
  } else if (categories && categories.length > 0) {
    query.category = { $in: categories };
  }

  if (platform && platform !== "all") {
    const escapedPlatform = platform.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.platform = { $regex: new RegExp(`^${escapedPlatform}$`, "i") };
  }

  if (name && name.trim()) {
    const escapedName = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.name = { $regex: new RegExp(escapedName, "i") };
  }

  if (search && search.trim()) {
    const escapedSearch = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const searchRegex = new RegExp(escapedSearch, "i");

    // Search matching skills by name
    const matchingSkills = await DB_Skill.find({ name: { $regex: searchRegex } }, "_id");
    const skillIds = matchingSkills.map((s) => s._id);

    const orConditions: Array<Record<string, unknown>> = [
      { name: { $regex: searchRegex } },
      { blurb: { $regex: searchRegex } },
      { client: { $regex: searchRegex } },
      { role: { $regex: searchRegex } },
    ];

    if (skillIds.length > 0) {
      orConditions.push({ skills: { $in: skillIds } });
    }

    query.$or = orConditions;
  }

  try {
    const [data, totalCount] = await Promise.all([
      DB_Project.find(query)
        .populate({
          path: "skills",
          select: "name group isFeatured isPublished",
        })
        .sort("-isCurrent -endDate -createdAt")
        .skip((page - 1) * size)
        .limit(size),
      DB_Project.countDocuments(query),
    ]);

    const totalPages = Math.ceil(totalCount / size);

    return c.json({
      data,
      meta: {
        size,
        page,
        totalPages,
        totalCount,
        isFirstPage: page === 1,
        isLastPage: page >= totalPages,
      },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

/** One project by id, published or not, with its full body for editing. */
projects.get("/admin/:id", async (c) => {
  const project = await DB_Project.findById(c.req.param("id")).populate({
    path: "skills",
    select: "name group isFeatured isPublished",
  });
  if (!project) return c.json({ error: "Not found" }, 404);

  return c.json(project);
});

projects.post("/admin", async (c) => {
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

  const category = typeof body.category === "string" ? body.category.trim() : "personal";
  const platform = typeof body.platform === "string" ? body.platform.trim() : "Web";
  const blurb = typeof body.blurb === "string" && body.blurb.trim()
    ? body.blurb.trim()
    : content
      ? deriveExcerpt(content)
      : "";
  const plainText = content ? derivePlainText(content) : "";

  const rawSkills = Array.isArray(body.skills) ? body.skills : [];
  const skills = rawSkills.map((s: unknown) =>
    typeof s === "object" && s && "_id" in s ? (s as { _id: string })._id : s,
  );

  const project = new DB_Project({
    uri: await uniqueUri(createURI(name)),
    name,
    category,
    platform,
    link: typeof body.link === "string" ? body.link.trim() : "",
    linkType: typeof body.linkType === "string" ? body.linkType.trim() : "",
    blurb,
    content,
    plainText,
    details: typeof body.details === "string" ? body.details : "",
    client: typeof body.client === "string" ? body.client.trim() : "",
    role: typeof body.role === "string" ? body.role.trim() : "",
    skills,
    startDate: typeof body.startDate === "string" ? body.startDate : "",
    endDate: typeof body.endDate === "string" ? body.endDate : "",
    thumbnail: typeof body.thumbnail === "string" ? body.thumbnail.trim() : "",
    isCurrent: body.isCurrent === true,
    isFeatured: body.isFeatured === true,
    isPublished: body.isPublished === true,
  });

  await project.save();

  return c.json(project, 201);
});

projects.put("/admin/:id", async (c) => {
  const body = await c.req.json();
  const project = await DB_Project.findById(c.req.param("id")).select("+plainText");
  if (!project) return c.json({ error: "Not found" }, 404);

  if (typeof body.name === "string" && body.name.trim()) {
    project.name = body.name.trim();
  }
  if (typeof body.category === "string") project.category = body.category.trim();
  if (typeof body.platform === "string") project.platform = body.platform.trim();
  if (typeof body.link === "string") project.link = body.link.trim();
  if (typeof body.linkType === "string") project.linkType = body.linkType.trim();
  if (typeof body.client === "string") project.client = body.client.trim();
  if (typeof body.role === "string") project.role = body.role.trim();
  if (typeof body.startDate === "string") project.startDate = body.startDate;
  if (typeof body.endDate === "string") project.endDate = body.endDate;
  if (typeof body.thumbnail === "string") project.thumbnail = body.thumbnail.trim();
  if (typeof body.isCurrent === "boolean") project.isCurrent = body.isCurrent;
  if (typeof body.isFeatured === "boolean") project.isFeatured = body.isFeatured;
  if (typeof body.isPublished === "boolean") project.isPublished = body.isPublished;

  if (Array.isArray(body.skills)) {
    project.skills = body.skills.map((s: unknown) =>
      typeof s === "object" && s && "_id" in s ? (s as { _id: string })._id : s,
    );
  }

  if (body.content !== undefined) {
    if (body.content === null) {
      project.content = undefined;
    } else {
      let content: EditorDocument;
      try {
        content = parseContent(body.content);
      } catch (error) {
        if (error instanceof BlockContentError) return c.json({ error: error.message }, 400);
        throw error;
      }
      project.content = content;
      project.markModified("content");
      if (!body.blurb) {
        project.blurb = deriveExcerpt(content);
      }
      project.plainText = derivePlainText(content);
    }
  }

  if (typeof body.blurb === "string") {
    project.blurb = body.blurb.trim();
  }
  if (typeof body.details === "string") {
    project.details = body.details;
  }

  if (typeof body.uri === "string" && body.uri.trim()) {
    const requested = createURI(body.uri);
    if (requested !== project.uri) {
      project.uri = await uniqueUri(requested, project.id);
    }
  }

  await project.save();

  return c.json(project);
});

projects.delete("/admin/:id", async (c) => {
  const project = await DB_Project.findByIdAndDelete(c.req.param("id"));
  if (!project) return c.json({ error: "Not found" }, 404);

  return c.json({ deleted: project.id });
});

// --- Helpers -----------------------------------------------------------------

function parseContent(input: unknown): EditorDocument {
  if (JSON.stringify(input ?? null).length > MAX_CONTENT_BYTES) {
    throw new BlockContentError("content exceeds maximum project size");
  }
  return normalizeDocument(input);
}

async function uniqueUri(base: string, excludeId?: string): Promise<string> {
  const slug = base || "project";

  for (let suffix = 0; suffix < 50; suffix += 1) {
    const candidate = suffix === 0 ? slug : `${slug}-${suffix + 1}`;
    const clash = await DB_Project.exists({
      uri: candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
    if (!clash) return candidate;
  }

  return `${slug}-${Date.now()}`;
}

export default projects;
