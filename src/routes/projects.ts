import { Hono } from 'hono';
import {getXataClient} from '../xata';


const xata = getXataClient();

const projects = new Hono();

projects.get('/', async (c) => {
    let projects =
        await xata.db.projects
            .select(['name', 'thumbnail.url', 'hasNotes', 'slug', 'shortDescription', 'showLink', 'link', 'group', 'category', 'skills'])
            .sort('started', 'desc')
            .getAll();
    return c.json(projects);
});

projects.get('/byGroup/:group', async (c) => {
    const group = c.req.param('group');
    let projects = await xata.db.projects.filter({ group }).getAll();
    return c.json(projects);
});

projects.get('/:slug', async (c) => {
    const slug = c.req.param('slug');

    let project = await xata.db.projects
        .filter({ slug })
        .getFirst();

     return c.json(project);
});

projects.get('/bySkill/:id', async (c) => {
    let skillID = c.req.param('id');

    if (!skillID) {
        return c.json('invalid skill id');
    }

    let projects =  await xata.db.projects
        .filter({
        skills: { $includes: skillID },
    })
        .select(['name', 'slug', 'group'])
        .getMany();

    return c.json(projects);
});

export default projects;
