import { describe, expect, test } from "bun:test";
import {
  createLifecycle,
  dropped,
  isValidClaim,
  referencedPaths,
  type Claim,
  type LifecyclePorts,
  type MediaEntry,
} from "../media/lifecycle.ts";

const HOUR = 60 * 60 * 1000;
const hex = (char: string) => char.repeat(32);
const media = (char: string, size?: number) =>
  `/media/2026/08/${hex(char)}${size ? `-${size}` : ""}.webp`;
const url = (path: string) => `https://cdn.example${path}`;

const imageBlock = (path: string) => ({ type: "image", data: { file: { url: url(path) } } });

// --- A small in-memory catalogue the lifecycle runs against -------------------

interface Row extends MediaEntry {
  lastUploadedAt: Date;
}

function world(now = new Date("2026-08-20T12:00:00Z")) {
  const rows = new Map<string, Row>();
  /** Which paths each fake document references. */
  const documents = new Map<string, Set<string>>();
  const destroyed: string[] = [];
  const warnings: unknown[][] = [];
  let failReferenceCheck = false;

  const add = (char: string, ageHours = 0, claims: Claim[] = []) => {
    const path = media(char);
    rows.set(path, {
      id: path,
      path,
      claims,
      lastUploadedAt: new Date(now.getTime() - ageHours * HOUR),
    });
    return rows.get(path)!;
  };
  const reference = (documentId: string, ...paths: string[]) =>
    documents.set(documentId, new Set(paths));
  const unreference = (documentId: string) => documents.delete(documentId);

  const ports: LifecyclePorts = {
    findByPaths: async (paths) => paths.flatMap((path) => rows.get(path) ?? []),
    findByClaim: async ({ kind, id, slot }) =>
      [...rows.values()].filter((row) =>
        row.claims.some(
          (claim) => claim.kind === kind && claim.id === id && (!slot || claim.slot === slot),
        ),
      ),
    findStale: async (before, after, limit) =>
      [...rows.values()]
        .filter((row) => row.lastUploadedAt < before && (!after || row.id > after))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit),
    addClaim: async (id, claim) => void rows.get(id)!.claims.push(claim),
    countReferences: async (path) => {
      if (failReferenceCheck) throw new Error("database unavailable");
      return [...documents.values()].filter((paths) => paths.has(path)).length;
    },
    destroy: async (entry) => {
      destroyed.push(entry.path);
      rows.delete(entry.path);
    },
  };

  const log = { warn: (...args: unknown[]) => void warnings.push(args), info: () => {} };

  return {
    rows,
    destroyed,
    warnings,
    add,
    reference,
    unreference,
    failChecks: (value: boolean) => (failReferenceCheck = value),
    lifecycle: createLifecycle(ports, log),
    now,
  };
}

const claimOf = (kind: Claim["kind"], slot: string, id = "a".repeat(24)): Claim => ({
  kind,
  id,
  slot,
});

// --- What a document references -----------------------------------------------

describe("referencedPaths", () => {
  test("finds image blocks in content and notes, and logo and thumbnail fields", () => {
    const paths = referencedPaths({
      content: { blocks: [imageBlock(media("a")), { type: "paragraph", data: { text: "x" } }] },
      notes: { blocks: [imageBlock(media("b"))] },
      logo: url(media("c")),
      thumbnail: media("d"),
    });
    expect([...paths].sort()).toEqual([media("a"), media("b"), media("c"), media("d")]);
  });

  test("ignores static asset names, legacy strings, and anything malformed", () => {
    expect(referencedPaths({ logo: "rust", thumbnail: "bfp", notes: "# markdown" }).size).toBe(0);
    expect(referencedPaths({ content: null, notes: undefined }).size).toBe(0);
    expect(referencedPaths({ content: { blocks: "nope" } }).size).toBe(0);
    expect(
      referencedPaths({ content: { blocks: [null, 7, { type: "image" }, { type: "image", data: {} }] } })
        .size,
    ).toBe(0);
  });

  test("does not treat a private original or a foreign URL as media", () => {
    expect(
      referencedPaths({ logo: `/originals/2026/08/${hex("a")}.png` }).size,
    ).toBe(0);
    expect(referencedPaths({ logo: "https://evil.example/media/2026/08/x.png" }).size).toBe(0);
  });

  test("dropped is what a save stopped using", () => {
    expect(dropped(new Set(["a", "b", "c"]), new Set(["b", "d"])).sort()).toEqual(["a", "c"]);
  });
});

describe("isValidClaim", () => {
  const id = "a".repeat(24);
  test("accepts known owners and slots", () => {
    expect(isValidClaim({ kind: "skill", id, slot: "logo" })).toBe(true);
    expect(isValidClaim({ kind: "article", id, slot: "body" })).toBe(true);
  });
  test("rejects unknown kinds, slots, and malformed ids", () => {
    expect(isValidClaim({ kind: "user" as never, id, slot: "logo" })).toBe(false);
    expect(isValidClaim({ kind: "skill", id, slot: "banner" })).toBe(false);
    expect(isValidClaim({ kind: "article", id, slot: "logo" })).toBe(false);
    expect(isValidClaim({ kind: "skill", id: "../x", slot: "logo" })).toBe(false);
  });
});

// --- release ------------------------------------------------------------------

describe("release", () => {
  test("deletes an image nothing references any more", async () => {
    const w = world();
    w.add("a");

    expect(await w.lifecycle.release([media("a")])).toEqual([media("a")]);
    expect(w.destroyed).toEqual([media("a")]);
  });

  test("never deletes an image another document still uses (identical uploads are one file)", async () => {
    const w = world();
    w.add("a");
    w.reference("article-b", media("a"));

    expect(await w.lifecycle.release([media("a")])).toEqual([]);
    expect(w.destroyed).toEqual([]);
  });

  test("ignores paths with no catalogue record", async () => {
    const w = world();
    expect(await w.lifecycle.release([media("f")])).toEqual([]);
  });

  test("a lookup failure keeps the file and does not throw", async () => {
    const w = world();
    w.add("a");
    w.failChecks(true);

    expect(await w.lifecycle.release([media("a")])).toEqual([]);
    expect(w.destroyed).toEqual([]);
    expect(w.warnings.length).toBeGreaterThan(0);
  });
});

describe("releaseOwner", () => {
  test("deletes what the owner referenced and what it uploaded but never used", async () => {
    const w = world();
    const owner = claimOf("skill", "logo");
    w.add("a"); // referenced by the deleted skill's body
    w.add("b", 0, [owner]); // uploaded for the skill's logo, never saved
    w.add("c"); // unrelated

    const gone = await w.lifecycle.releaseOwner(owner.kind, owner.id, [media("a")]);
    expect(gone.sort()).toEqual([media("a"), media("b")]);
    expect(w.rows.has(media("c"))).toBe(true);
  });

  test("keeps anything else still points at", async () => {
    const w = world();
    const owner = claimOf("skill", "logo");
    w.add("a", 0, [owner]);
    w.reference("project-1", media("a"));

    expect(await w.lifecycle.releaseOwner(owner.kind, owner.id, [media("a")])).toEqual([]);
  });
});

// --- claim: single-image slots ------------------------------------------------

describe("claim", () => {
  test("uploading a replacement logo deletes earlier unsaved candidates", async () => {
    const w = world();
    const logo = claimOf("skill", "logo");
    const first = w.add("a");
    await w.lifecycle.claim(first, logo);
    const second = w.add("b");
    await w.lifecycle.claim(second, logo);
    const third = w.add("c");
    const gone = await w.lifecycle.claim(third, logo);

    // Ten tries leave one: only the latest candidate survives.
    expect([...w.rows.keys()]).toEqual([media("c")]);
    expect(gone).toEqual([media("b")]);
    expect(w.destroyed.sort()).toEqual([media("a"), media("b")]);
  });

  test("the logo currently saved on the skill survives until a save switches to the new one", async () => {
    const w = world();
    const logo = claimOf("skill", "logo");
    const current = w.add("a", 100, [logo]);
    w.reference("skill-1", current.path);

    await w.lifecycle.claim(w.add("b"), logo);
    expect(w.rows.has(media("a"))).toBe(true);

    // The save moves the skill to B; its release then drops A.
    w.reference("skill-1", media("b"));
    await w.lifecycle.release([media("a")]);
    expect([...w.rows.keys()]).toEqual([media("b")]);
  });

  test("a slot that holds many images never supersedes", async () => {
    const w = world();
    const body = claimOf("article", "body");
    await w.lifecycle.claim(w.add("a"), body);
    await w.lifecycle.claim(w.add("b"), body);
    expect(w.rows.size).toBe(2);
    expect(w.destroyed).toEqual([]);
  });

  test("slots of different owners do not interfere", async () => {
    const w = world();
    await w.lifecycle.claim(w.add("a"), claimOf("skill", "logo", "1".repeat(24)));
    await w.lifecycle.claim(w.add("b"), claimOf("skill", "logo", "2".repeat(24)));
    expect(w.rows.size).toBe(2);
  });

  test("claiming the same slot twice is recorded once", async () => {
    const w = world();
    const logo = claimOf("skill", "logo");
    const entry = w.add("a");
    await w.lifecycle.claim(entry, logo);
    await w.lifecycle.claim({ ...entry, claims: [logo] }, logo);
    expect(w.rows.get(media("a"))!.claims).toHaveLength(1);
  });
});

// --- sweep --------------------------------------------------------------------

describe("sweep", () => {
  test("deletes old unreferenced uploads and leaves recent and referenced ones", async () => {
    const w = world();
    w.add("a", 48); // abandoned
    w.add("b", 48); // old but in use
    w.add("c", 1); // an article being written right now
    w.reference("article-1", media("b"));

    const result = await w.lifecycle.sweep({ graceMs: 24 * HOUR, now: w.now });

    expect(result).toEqual({ scanned: 2, deleted: [media("a")], dryRun: false });
    expect([...w.rows.keys()].sort()).toEqual([media("b"), media("c")]);
  });

  test("the grace period protects an image mid-authoring", async () => {
    const w = world();
    w.add("a", 23);
    expect((await w.lifecycle.sweep({ graceMs: 24 * HOUR, now: w.now })).deleted).toEqual([]);
  });

  test("a dry run reports without deleting", async () => {
    const w = world();
    w.add("a", 48);

    const result = await w.lifecycle.sweep({ graceMs: 24 * HOUR, now: w.now, dryRun: true });
    expect(result).toMatchObject({ deleted: [media("a")], dryRun: true });
    expect(w.destroyed).toEqual([]);
    expect(w.rows.size).toBe(1);
  });

  test("walks more than one page", async () => {
    const w = world();
    // 250 records against a page size of 100, each with a distinct path.
    for (let index = 0; index < 250; index += 1) {
      const path = `/media/2026/08/${index.toString(16).padStart(32, "0")}.webp`;
      w.rows.set(path, { id: path, path, claims: [], lastUploadedAt: new Date(0) });
    }
    const total = w.rows.size;

    const result = await w.lifecycle.sweep({ graceMs: HOUR, now: w.now });
    expect(result.scanned).toBe(total);
    expect(w.rows.size).toBe(0);
  });

  test("deletes nothing when references cannot be checked", async () => {
    const w = world();
    w.add("a", 48);
    w.failChecks(true);

    const result = await w.lifecycle.sweep({ graceMs: 24 * HOUR, now: w.now });
    expect(result.deleted).toEqual([]);
    expect(w.rows.size).toBe(1);
  });
});
