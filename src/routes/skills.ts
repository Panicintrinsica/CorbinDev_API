import { Hono } from "hono";
import DB_Skill from "../schema/skill.schema.ts";

const skills = new Hono();

skills.get("/", async (c) => {
  const skills = await DB_Skill.find();

  return c.json(skills);
});

skills.get("/:id", async (c) => {
  const skillID = c.req.param("id");
  const skill = await DB_Skill.findById(skillID);
  return c.json(skill);
});

skills.post("/admin", async (c) => {
  const {
    name,
    acquired,
    proficiency,
    level,
    logo,
    link,
    group,
    notes,
    isFeatured,
    isPublished,
  } = await c.req.json();

  const skill = new DB_Skill({
    name,
    acquired,
    proficiency,
    level,
    logo,
    link,
    group,
    notes,
    isFeatured,
    isPublished,
  });

  await skill.save();

  return c.json(skill);
});

skills.get("admin/ids", async (c) => {
  const skills = await DB_Skill.find().select("_id name");

  return c.json(skills);
});

export default skills;
