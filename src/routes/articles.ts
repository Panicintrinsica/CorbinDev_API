import { Hono } from 'hono';
import { getXataClient } from '../xata';

const xata = getXataClient();

const articles = new Hono();

articles.get('page/:size/:offset', async (c) => {
    const size = Number(c.req.param('size'));
    const offset = Number(c.req.param('offset'));

    const page = await xata.db.articles
        .select(["title", "slug", "aboveFold", "tags", "category"])
        .sort("xata.createdAt", "desc")
        .getPaginated({
            pagination: {
                size, offset: Number(offset * size),
            },
        });

    return c.json(page);
});


articles.get('single/:slug', async (c) => {

    const slug = c.req.param('slug');

    const article = await xata.db.articles
        .filter({slug: slug})
        .getFirst();

    return c.json(article);
});

export default articles;

