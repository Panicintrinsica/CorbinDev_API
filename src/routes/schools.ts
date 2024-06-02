import { Hono } from 'hono';
import {getXataClient} from "../xata.ts";

const xata = getXataClient();
const schools = new Hono();

schools.get('/', async (c) => {
    const results = await xata.db["schools"].getAll();
    return c.json(results);
});

schools.get('/:id', (c) => {
    return c.json('get schools by id');
});

export default schools;
