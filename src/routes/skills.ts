import { Hono } from "hono";
import { getXataClient } from "../xata.ts";
import { CacheType, handleCache } from "../services/cache.service.ts";

const skills = new Hono();

// Generated with CLI
const xata = getXataClient();

skills.get("/", async (c) => {
  const data = await handleCache(
    "public_skills",
    CacheType.COLLECTION,
    xata.db["skills"]
      .select([
        "name",
        "learned",
        "years",
        "level",
        "isPublic",
        "isFeatured",
        "group",
        "notes",
        "link",
      ] as any)
      .getAll(),
  );

  return c.json(data);
});

skills.get("/list", async (c) => {
  const skills = await xata.db["skills"].select(["name"] as any).getAll();

  return c.json(skills);
});

skills.get("/byID/:id", async (c) => {
  const skillID = c.req.param("id");

  const data = await handleCache(
    skillID,
    CacheType.SKILL,
    xata.db["skills"].read(skillID),
  );

  return c.json(data);
});

skills.get("/byName/:name", async (c) => {
  const name = c.req.param("name");

  const data = await handleCache(
    name,
    CacheType.SKILL,
    xata.db["skills"].filter({ name }).getFirst(),
  );

  return c.json(data);
});

skills.get("/byProject/:id", async (c) => {
  const projectID = c.req.param("id");

  const data = await handleCache(
    "skills_byProject",
    CacheType.COLLECTION,
    xata.db.projects_skills
      .filter({ "project.id": projectID })
      .select(["skill.id", "skill.name", "skill.isFeatured"])
      .getAll(),
  );

  return c.json(data);
});

export default skills;
