import type { KVNamespace } from '@cloudflare/workers-types';

/** How long block/white lists stay cached in-isolate before re-reading KV. */
export const LIST_CACHE_TTL_MS = 30_000;

interface CachedLists {
  block: string[];
  white: string[];
  expiresAt: number;
}

/**
 * In-isolate cache for the KV-backed lists, keyed by the KV binding. Avoids 2
 * KV reads per email; keyed weakly so entries are collected with the binding
 * itself instead of leaking across test environments / isolate lifetimes.
 */
const listCache = new WeakMap<KVNamespace, CachedLists>();

export function getCachedLists(db: KVNamespace): CachedLists | undefined {
  const cached = listCache.get(db);
  return cached && cached.expiresAt > Date.now() ? cached : undefined;
}

export function setCachedLists(db: KVNamespace, block: string[], white: string[]): void {
  listCache.set(db, { block, white, expiresAt: Date.now() + LIST_CACHE_TTL_MS });
}

/** Drop the cached lists for a binding — call after any list mutation. */
export function invalidateListCache(db: KVNamespace): void {
  listCache.delete(db);
}
