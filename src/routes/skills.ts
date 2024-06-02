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

skills.get('/:id', async (c) => {
    const skillID = c.req.param('id');
    const skill = await xata.db["skills"].read(skillID);
    return c.json(skill);
});

skills.get('/byName/:name', async (c) => {
    const name = c.req.param('name');
    const skill = await xata.db["skills"].filter({ name }).getFirst();
    return c.json(skill);
});

export default skills;
