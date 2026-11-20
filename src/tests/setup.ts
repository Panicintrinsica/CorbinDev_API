import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One throwaway media directory for the whole test run. Bun shares a module cache
// across test files, so this has to be settled before the first import of storage.ts.
const root = mkdtempSync(join(tmpdir(), "corbin-media-"));
process.env.MEDIA_DIR = root;

afterAll(() => rmSync(root, { recursive: true, force: true }));

// Bun loads .env into every test process. Tests must never reach the real object
// store, so force local-disk mode; the remote tests supply their own environment.
delete process.env.STORAGE_PUBLIC_BUCKET;
