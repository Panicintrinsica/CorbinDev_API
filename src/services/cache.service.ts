import { Database } from "bun:sqlite";

const db = new Database("cache.sqlite");

function initCache() {
  try {
    db.run(
      "CREATE TABLE IF NOT EXISTS articles (id STRING PRIMARY KEY, data TEXT)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS projects (id STRING PRIMARY KEY, data TEXT)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS skills (id STRING PRIMARY KEY, data TEXT)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS contents (id STRING PRIMARY KEY, data TEXT)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS results (id STRING PRIMARY KEY, data TEXT)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS collections (id STRING PRIMARY KEY, data TEXT)",
    );
  } catch (err) {
    console.log(err);
  }
}

function cacheSave(key: string, data: Object, type: CacheType) {
  if (!/^[a-zA-Z0-9_]+$/.test(type)) {
    console.warn("Invalid cache table name");
  }

  const input = JSON.stringify(data);
  db.run(`INSERT INTO ${type} VALUES (?, ?)`, [key, input]);
}

function cacheLoad(key: string, type: CacheType) {
  if (!/^[a-zA-Z0-9_]+$/.test(type)) {
    console.warn("Invalid cache table name");
  }

  let item = db.query(`SELECT * FROM ${type} WHERE id = ?`).get(key) as
    | { id: string; data: string }
    | undefined;

  if (!item) {
    console.debug(`Cache miss for ${key}`);
    return;
  }

  return JSON.parse(item.data);
}

function cacheDelete(key: string, table: CacheType) {
  db.run("DELETE FROM ? WHERE id = ?", [table, key]);
}

function cacheClear() {
  db.run("DELETE FROM articles");
  db.run("DELETE FROM projects");
  db.run("DELETE FROM skills");
  db.run("DELETE FROM content");
}

interface cacheItem {
  id: string;
  data: string;
}

/**
 * Handles caching logic for database queries.
 *
 * @param cacheKey - The key for accessing the cache.
 * @param cacheType - The type of cache (e.g., CacheType.QUERYSET).
 * @param query - A promise or query directly fetching the data.
 * @returns The cached or fetched data.
 */
async function handleCache<T>(
  cacheKey: string,
  cacheType: CacheType,
  query: Promise<T>,
): Promise<T | { message: string; status: number }> {
  // Try to load from cache
  const cache = cacheLoad(cacheKey, cacheType);

  if (cache) {
    // Return cached data if available
    return cache;
  }

  // Await the provided query for data
  const data = await query;

  // If no data is returned, provide a default response object
  if (data === null || data === undefined) {
    return { message: "No Content", status: 404 };
  }

  // Save the fetched data to cache
  cacheSave(cacheKey, data, cacheType);

  // Return the fetched data
  return data;
}

enum CacheType {
  ARTICLE = "articles",
  PROJECT = "projects",
  SKILL = "skills",
  CONTENT = "contents",
  COLLECTION = "collections",
  SEARCH = "results",
}

export {
  CacheType,
  initCache,
  cacheSave,
  cacheLoad,
  cacheDelete,
  cacheClear,
  handleCache,
};
