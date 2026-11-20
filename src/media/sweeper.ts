/**
 * The background half of storage housekeeping: deletes uploads that were never
 * attached to anything.
 *
 * Saves clean up after themselves (see `media/lifecycle.ts`), so this only has to
 * catch what no save ever saw — an image inserted into a draft that was then
 * abandoned, a logo picked and never kept — plus anything left over from before
 * cleanup existed.
 */

import { lifecycle } from "./catalog.ts";

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long an unreferenced upload is left alone. Editor.js uploads the moment an
 * image is inserted, so an article being written is full of "unreferenced" images
 * until its first save; this must comfortably exceed how long a draft sits open.
 */
export const ORPHAN_GRACE_MS =
  Math.max(Number(Bun.env.MEDIA_ORPHAN_GRACE_HOURS) || 24, 1) * HOUR_MS;

const INTERVAL_MS = Math.max(Number(Bun.env.MEDIA_SWEEP_INTERVAL_HOURS) || 6, 1) * HOUR_MS;

async function runOnce(): Promise<void> {
  try {
    const { scanned, deleted } = await lifecycle.sweep({ graceMs: ORPHAN_GRACE_MS });
    if (deleted.length > 0) {
      console.info(`[media] sweep removed ${deleted.length} of ${scanned} stale uploads`);
    }
  } catch (error) {
    // A failed sweep is retried next interval; it must never take the API down.
    console.warn("[media] sweep failed:", error);
  }
}

/** Starts the periodic sweep. `MEDIA_SWEEP=off` disables it, e.g. for a second replica. */
export function startMediaSweeper(): void {
  if (Bun.env.MEDIA_SWEEP === "off") return;

  // Not at boot: a crash loop would otherwise sweep on every restart.
  setTimeout(runOnce, 5 * 60 * 1000).unref();
  setInterval(runOnce, INTERVAL_MS).unref();
}
