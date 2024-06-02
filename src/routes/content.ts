import { Hono } from 'hono';
import { getXataClient } from '../xata';

const xata = getXataClient();

const siteContent = new Hono();

siteContent.get('/:selector', async (c) => {
    const contentBlock = await xata.db.content
        .filter({slug: c.req.param('selector')})
        .getFirst();

    return c.json(contentBlock);
});


siteContent.get('/group/:selector', async (c) => {
    const contentSet = await xata.db.content
        .filter({group: c.req.param('selector')})
        .getMany();

    return c.json(contentSet);
});

export default siteContent;

