import { Hono } from 'hono';
import {getXataClient} from '../xata';

const xata = getXataClient();

const projects = new Hono();

projects.get('/', async (c) => {
    let projects =
        await xata.db.projects
            .select(['name', 'thumbnail.url', 'slug', 'shortDescription', 'hasNotes', 'showLink', 'link', 'group', 'category'])
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
    let projects =  await xata.db.projects
        .filter({
            skills: { $includes: c.req.param('id') },
        })
        .select(['name', 'slug', 'group'])
        .getMany();

    return c.json(projects);
});

export default projects;
