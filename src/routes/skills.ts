import { Hono } from 'hono';
import { getXataClient } from "../xata";

const skills = new Hono();

// Generated with CLI
const xata = getXataClient();

skills.get('/', async (c) => {
    const skills = await xata.db["skills"]
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
        .getAll();
    
    return c.json(skills);
});

skills.get('/list', async (c) => {
    const skills = await xata.db["skills"]
        .select([
            "name",
        ] as any)
        .getAll();

    return c.json(skills);
});

skills.get('/byID/:id', async (c) => {
    const skillID = c.req.param('id');
    const skill = await xata.db["skills"].read(skillID);
    return c.json(skill);
});

skills.get('/byName/:name', async (c) => {
    const name = c.req.param('name');
    const skill = await xata.db["skills"].filter({ name }).getFirst();
    return c.json(skill);
});


skills.get('/byProject/:id', async (c) => {
    const projectID = c.req.param('id');
    const skills =
        await xata.db.projects_skills
            .filter({ 'project.id': projectID })
            .select(['skill.id', 'skill.name', 'skill.isFeatured'])
            .getAll()
    return c.json(skills);
});



export default skills;
