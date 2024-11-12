import { Hono } from "hono";
import { getXataClient } from "../xata";

const xata = getXataClient();

const projects = new Hono();

/**
 * Gets a list of public projects
 */
projects.get("", async (c) => {
  let projects = await xata.db.projects
    .filter({ isPublic: true })
    .sort("started", "desc")
    .getAll();
  return c.json(projects);
});

/**
 * Gets a list of all projects by a specific group
 */
projects.get("/byGroup/:group", async (c) => {
  const group = c.req.param("group");
  let projects = await xata.db.projects
    .filter({ group, isPublic: true })
    .getAll();
  return c.json(projects);
});

/**
 * Gets the full details of a specific project by its slug
 */
projects.get("/bySlug/:slug", async (c) => {
  const slug = c.req.param("slug");

  let project = await xata.db.projects
    .filter({ slug, isPublic: true })
    .getFirst();

  return c.json(project);
});

/**
 * Gets a list of all projects that used a specific skill
 */
projects.get("/bySkill/:id", async (c) => {
  const skillID = c.req.param("id");
  const skills = await xata.db.projects_skills
    .filter({ "skill.id": skillID, "project.isPublic": true })
    .select(["project.id", "project.name", "project.group", "project.slug"])
    .getAll();
  return c.json(skills);
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
