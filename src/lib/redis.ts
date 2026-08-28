import IORedis from "ioredis";
import { env } from "../config/env";

export const redis = new IORedis(env.redisUrl, {
  maxRetriesPerRequest: null,
});

// --- List cache: version-bumped -----------------------------------------
// The product list is cached per (category, page, size, sort) combination —
// there's no way to enumerate and delete every such key when a promotion
// changes, so instead every list cache key embeds this version number.
// Bumping it on any promotion or product change "invalidates" every list
// cache entry at once, without touching the products table. See ADR.md,
// Scenario B.
export const CATALOG_LIST_VERSION_KEY = "catalog:list:version";

export async function getOrInitVersion(key: string): Promise<number> {
  const value = await redis.get(key);
  if (value) return Number(value);
  await redis.set(key, "1", "NX");
  return 1;
}

export async function bumpVersion(key: string): Promise<void> {
  await redis.incr(key);
}

// --- Active-promotion cache: direct delete ------------------------------
// Unlike the list cache, there is exactly one cache entry per product and
// per category here, so invalidation is a plain key delete — no version
// needed. This is also what makes a brand-new product in a category with an
// active flash sale "just work" for caching too: it reads the same
// `promo:active:category:{id}` entry every other product in that category
// reads, with no per-product backfill required.
export const activePromoProductKey = (productId: string) => `promo:active:product:${productId}`;
export const activePromoCategoryKey = (categoryId: string) => `promo:active:category:${categoryId}`;

// The product row itself, for GET /products/:id — the case study calls this
// out as the single highest-traffic endpoint. There's no event hook back
// from the ingestion Lambdas (a separate deployable, no shared Redis client)
// when a vendor file updates a product's basePrice, so this relies on a
// short TTL to bound staleness rather than explicit invalidation — an
// acceptable trade-off given vendor files land weekly, not continuously.
export const productCoreKey = (productId: string) => `product:core:${productId}`;

const NULL_MARKER = "__null__";

const LOCK_TTL_MS = 5000; // generous vs. the ~90ms worst-case query this guards (see ADR.md)
const LOCK_POLL_INTERVAL_MS = 50;
const LOCK_MAX_POLLS = 40; // ~2s of waiting before giving up and computing it ourselves

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deserialize<T>(cached: string): T | null {
  return cached === NULL_MARKER ? null : (JSON.parse(cached) as T);
}

/**
 * Caches `null` too (as a sentinel) so "no active promotion" is still a
 * cache hit, not a DB miss every time.
 *
 * Stampede-protected: when a key is invalidated (e.g. a flash sale is
 * created, wiping every cached list page for its category), the next
 * request for that key isn't necessarily one request — during a flash sale
 * it could be thousands, all missing the cache in the same instant. Without
 * protection, all of them would hit Postgres at once for identical work.
 * See "how it works" below.
 */
export async function cacheGetOrSet<T>(key: string, ttlSeconds: number, load: () => Promise<T | null>): Promise<T | null> {
  const cached = await redis.get(key);
  if (cached !== null) return deserialize<T>(cached);

  const lockKey = `lock:${key}`;
  // SET NX: only the first caller to reach this line for this key gets
  // "true" back — every simultaneous miss after it gets "null" instead, in
  // one atomic Redis operation (no separate check-then-set race).
  const acquiredLock = await redis.set(lockKey, "1", "PX", LOCK_TTL_MS, "NX");

  if (acquiredLock) {
    try {
      const value = await load();
      await redis.set(key, value === null ? NULL_MARKER : JSON.stringify(value), "EX", ttlSeconds);
      return value;
    } finally {
      // Release as soon as we're done, not after the full LOCK_TTL_MS — so
      // waiters don't sit idle once the real answer is already cached.
      await redis.del(lockKey);
    }
  }

  // Someone else is already computing this key. Poll the cache instead of
  // also querying Postgres — this is the "thousands of requests, one
  // query" behavior.
  for (let i = 0; i < LOCK_MAX_POLLS; i++) {
    await sleep(LOCK_POLL_INTERVAL_MS);
    const nowCached = await redis.get(key);
    if (nowCached !== null) return deserialize<T>(nowCached);
  }

  // Safety valve: the lock holder likely crashed before writing the cache
  // key and releasing the lock. Rather than wait out the rest of
  // LOCK_TTL_MS (or fail the request), compute it ourselves — a rare
  // duplicate query beats a request that hangs.
  return load();
}

export async function cacheDelete(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await redis.del(...keys);
}
