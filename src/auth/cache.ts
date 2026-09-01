/**
 * A bounded in-process TTL map. Used for session-validation results and role
 * lookups so a hot path does not hit Hades or Mongo on every request.
 *
 * PORTABILITY: this is deliberately the smallest thing that works, and it is
 * per-process — two API instances cache independently. Swapping in Redis means
 * implementing the same three methods; nothing else in the module knows.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly maxEntries = 5000) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, ttlSeconds: number): void {
    if (this.entries.size >= this.maxEntries) {
      // Cheap eviction: drop the oldest insertion. Map preserves insertion order.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
