import { Hono } from "hono";
import { getXataClient } from "../xata.ts";
import { CacheType, handleCache } from "../services/cache.service.ts";

const xata = getXataClient();

const projects = new Hono();

/**
 * Gets a list of public projects
 */
projects.get("", async (c) => {
  const data = await handleCache(
    "proj_public",
    CacheType.COLLECTION,
    xata.db.projects
      .filter({ isPublic: true })
      .sort("started", "desc")
      .getAll(),
  );

  return c.json(data);
});

/**
 * Gets a list of all projects by a specific group
 */
projects.get("/byGroup/:group", async (c) => {
  const group = c.req.param("group");

  const data = await handleCache(
    `proj_${group}`,
    CacheType.COLLECTION,
    xata.db.projects.filter({ group, isPublic: true }).getAll(),
  );

  return c.json(data);
});

/**
 * Gets the full details of a specific project by its slug
 */
projects.get("/bySlug/:slug", async (c) => {
  const slug = c.req.param("slug");

  const data = await handleCache(
    slug,
    CacheType.PROJECT,
    xata.db.projects.filter({ slug, isPublic: true }).getFirst(),
  );

  return c.json(data);
});

/**
 * Gets a list of all projects that used a specific skill
 */
projects.get("/bySkill/:id", async (c) => {
  const skillID = c.req.param("id");

  const data = await handleCache(
    `proj_${skillID}`,
    CacheType.COLLECTION,
    xata.db.projects_skills
      .filter({ "skill.id": skillID, "project.isPublic": true })
      .select(["project.id", "project.name", "project.group", "project.slug"])
      .getAll(),
  );

  return c.json(data);
});

/**
 * Gets the full index of all projects
 */
projects.get("/fullIndex", async (c) => {
  let projects = await xata.db.projects
    .select(["name", "id"])
    .sort("started", "desc")
    .getAll();

  console.log(projects);
  return c.json(projects);
});

/**
 * Gets the CV entries for the requested projects
 * @param {string[]} ids - a string array of project IDs
 */
projects.post("forCV", async (c) => {
  let { ids } = await c.req.json();
  const projects = await xata.db.projects
    .filter({ id: { $any: ids } })
    .select([
      "name",
      "role",
      "client",
      "cvDescription",
      "link",
      "started",
      "ended",
    ])
    .getAll();

  return c.json(projects);
});

export default projects;
