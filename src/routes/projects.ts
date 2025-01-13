import { Hono } from "hono";
import DB_Project from "../schema/project.schema.ts";
import { createURI } from "../util.ts";

const projects = new Hono();

/**
 * Gets a list of public projects
 */
projects.get("", async (c) => {
  const projects = await DB_Project.find(
    { isPublished: true },
    "-_id uri name category platform link linkType blurb thumbnail isFeatured isCurrent isPublished",
  ).sort("-isCurrent -endDate");

  return c.json(projects);
});

projects.get("/byURI/:uri", async (c) => {
  const uri = c.req.param("uri");

  const projectDetails = await DB_Project.findOne({
    uri: uri,
    isPublished: true,
  }).populate({
    path: "skills",
    select: "name isFeatured isPublished",
  });

  return c.json(projectDetails);
});

projects.get("/bySkill/:id", async (c) => {
  const uri = c.req.param("id");

  const projectDetails = await DB_Project.find(
    { skills: uri, isPublished: true },
    "-_id name uri category",
  );
  return c.json(projectDetails);
});

projects.post("admin", async (c) => {
  const {
    name,
    category,
    platform,
    link,
    linkType,
    blurb,
    details,
    client,
    role,
    skills,
    startDate,
    endDate,
    thumbnail,
    isCurrent,
    isFeatured,
    isPublished,
  } = await c.req.json();

  const project = new DB_Project({
    uri: createURI(name),
    name,
    category,
    platform,
    link,
    linkType,
    blurb,
    details,
    client,
    role,
    skills,
    startDate,
    endDate,
    thumbnail,
    isCurrent,
    isPublished,
    isFeatured,
  });

  await project.save();

  return c.json(project);
});

export default projects;
