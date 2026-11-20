/**
 * Exercises storage.ts in object-store mode. Run as a subprocess by
 * storage.remote.test.ts, because storage.ts decides its backend from the
 * environment at import time and the rest of the suite needs local mode.
 */
import * as storage from "../../media/storage.ts";

const hash = "d".repeat(64);
const now = new Date(Date.UTC(2026, 7, 15));
const served = storage.pathFor("media", hash, "webp", now, 800);
const original = storage.pathFor("originals", hash, "png", now);

await storage.write(served, new Uint8Array([1, 2, 3]));
await storage.write(original, new Uint8Array([4, 5, 6]));
const stored = await storage.store(new Uint8Array([7, 8, 9]), "png", now);
await storage.remove(served);
await storage.remove(original);

let badPath = "";
try {
  await storage.write("/media/../../etc/passwd", new Uint8Array([0]));
} catch (error) {
  badPath = (error as Error).message;
}

console.log(
  JSON.stringify({
    served,
    original,
    storedPath: stored.path,
    read: await storage.read(served),
    url: storage.toPublicUrl(served, "https://api.example"),
    badPath,
  }),
);
