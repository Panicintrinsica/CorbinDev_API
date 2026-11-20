import * as s from "../../media/storage.ts";
import { processImage, pickFallback } from "../../media/process.ts";
import { identifyImage } from "../../media/image.ts";
const bytes = new Uint8Array(await Bun.file("C:/Users/panic/OneDrive/Pictures/kitties.png").arrayBuffer());
const info = identifyImage(bytes)!;
const hash = s.hashBytes(bytes);
const now = new Date();
const p = await processImage(bytes);
const orig = s.pathFor("originals", hash, info.extension, now);
const placed = p.variants.map(v => ({ v, path: s.pathFor("media", hash, v.format, now, v.width) }));
await Promise.all([s.write(orig, bytes), ...placed.map(e => s.write(e.path, e.v.data))]);
const urls = placed.map(e => s.toPublicUrl(e.path, "http://x"));
console.log(JSON.stringify({ orig, urls }, null, 1));
for (const u of urls.slice(0,2).concat(urls.slice(-1))) { const r = await fetch(u, {method:"HEAD"}); console.log(r.status, r.headers.get("content-type"), r.headers.get("cf-cache-status"), u); }
const o = await fetch(s.MEDIA_BASE_URL + orig, {method:"HEAD"}); console.log("original public:", o.status);
if (process.argv[2]==="cleanup") { await Promise.all([orig, ...placed.map(e=>e.path)].map(s.remove)); console.log("cleaned"); }
