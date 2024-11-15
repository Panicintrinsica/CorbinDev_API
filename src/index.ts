import { Hono } from 'hono';
import { cors } from 'hono/cors';

import articleRouter from './routes/articles.ts';
import skillsRouter from './routes/skills.ts';
import projectRouter from './routes/projects.ts';
import detailsRouter from './routes/details.ts';
import schoolRouter from './routes/schools.ts';
import contentRouter from './routes/content.ts';
import authRouter from './routes/auth.ts';

const app = new Hono()

app.use('/*', cors())

app.route("/articles", articleRouter)
app.route("/skills", skillsRouter)
app.route("/details", detailsRouter)
app.route("/projects", projectRouter)
app.route("/schools", schoolRouter)
app.route("/content", contentRouter)
app.route("/auth", authRouter)

let port = process.env.PORT || 3000;

Bun.serve({
    fetch: app.fetch,
    port: port
});

console.log(`Application is running and listening on port ${port}`);

await Bun.build({
    entrypoints: ['./index.ts'],
    outdir: './built'
})
