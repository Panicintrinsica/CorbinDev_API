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
    const skillID = c.req.param('id');
    const skills =
        await xata.db.projects_skills
            .filter({ 'skill.id': skillID })
            .select(['project.id', 'project.name', 'project.group', 'project.slug'])
            .getAll()
    return c.json(skills);
});

export default projects;
