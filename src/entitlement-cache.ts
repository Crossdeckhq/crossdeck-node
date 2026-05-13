/**
 * Per-customer entitlement cache with TTL — the third Crossdeck USP
 * on the server.
 *
 * Why this exists: server-side gating code looks like
 *
 *   if (server.isEntitled(customerId, "pro")) { … }
 *
 * inside a request handler. Without a cache, every request makes an
 * HTTP round-trip to `GET /v1/entitlements?customerId=…` — 50-200ms
 * per request, every request, for every customer. The cache makes
 * `isEntitled()` a `Map.get()` after the first warm.
 *
 * Differences from `@cross-deck/web/src/entitlement-cache.ts`:
 *   - **Per-customer**, not singleton. Web SDK has one user per browser
 *     tab; Node SDK has many users hitting one server. The cache is
 *     keyed by `crossdeckCustomerId`.
 *   - **TTL-bounded**. Each customer's entry expires after `ttlMs`
 *     (default 60_000) and the next read returns `false` until
 *     `getEntitlements()` refreshes. Stripe + Mixpanel ship the same
 *     pattern server-side.
 *   - **Subscriber API unchanged** — `subscribe(listener)` fires after
 *     any mutation (set / clear / per-customer expiry-driven eviction
 *     is NOT considered a mutation, by design — listeners shouldn't
 *     re-render just because a TTL elapsed).
 *
 * The cache holds only ACTIVE entitlements — `setForCustomer` filters.
 * `isEntitled()` returns `false` when:
 *   - the customer has no cached entry
 *   - the entry has expired
 *   - the requested key isn't in the active set
 */

import type { PublicEntitlement } from "./types";

export type EntitlementsListener = (
  customerId: string,
  entitlements: PublicEntitlement[],
) => void;

interface CacheEntry {
  /** Full entitlement objects (active + inactive — caller may want source/validUntil). */
  all: PublicEntitlement[];
  /** Active-only key set for O(1) `isEntitled` lookups. */
  active: Set<string>;
  /** epoch ms after which the entry is treated as cold. */
  expiresAt: number;
  /** epoch ms the entry was last populated. */
  populatedAt: number;
}

export interface EntitlementCacheOptions {
  /** TTL in ms. Default 60_000 (60s). 0 disables caching (every read is cold). */
  ttlMs?: number;
  /**
   * Maximum number of customers cached at once. Long-running multi-tenant
   * servers handling a long tail of customers would otherwise leak Map
   * entries forever. Default 10_000 — enough for any realistic deployment.
   * When the cap is reached, the OLDEST entry (by insertion / refresh
   * order) is evicted to make room. Eviction does NOT fire listeners
   * (passive eviction is not a mutation by design).
   */
  maxCustomers?: number;
}

const DEFAULT_MAX_CUSTOMERS = 10_000;

export class EntitlementCache {
  private readonly ttlMs: number;
  private readonly maxCustomers: number;
  private byCustomer = new Map<string, CacheEntry>();
  private listeners = new Set<EntitlementsListener>();
  private listenerErrorCount = 0;
  private evicted = 0;

  constructor(options: EntitlementCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxCustomers = options.maxCustomers ?? DEFAULT_MAX_CUSTOMERS;
  }

  /**
   * Synchronous lookup. Returns `true` iff the customer has the
   * entitlement AND the cache entry is fresh (within `ttlMs`).
   * Returns `false` otherwise (no entry / expired / key not active).
   */
  isEntitled(customerId: string, key: string): boolean {
    const entry = this.byCustomer.get(customerId);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) return false;
    return entry.active.has(key);
  }

  /**
   * Full snapshot for callers that need source / validUntil. Returns
   * `[]` when the customer has no cached entry or the entry has
   * expired.
   */
  list(customerId: string): PublicEntitlement[] {
    const entry = this.byCustomer.get(customerId);
    if (!entry) return [];
    if (Date.now() > entry.expiresAt) return [];
    return entry.all.slice();
  }

  /**
   * Whether a fresh entry exists for the customer. Useful for
   * deciding whether to warm before a hot path.
   */
  isFresh(customerId: string): boolean {
    const entry = this.byCustomer.get(customerId);
    return Boolean(entry && Date.now() <= entry.expiresAt);
  }

  /**
   * Replace (or insert) the cache entry for a customer. Sets the
   * `expiresAt` to `now + ttlMs`. Re-inserting an existing customerId
   * "touches" it — the entry moves to the end of insertion order
   * (Map semantics) so it's treated as most-recently-used for LRU
   * eviction. Fires listeners.
   */
  setForCustomer(customerId: string, entitlements: PublicEntitlement[]): void {
    const now = Date.now();
    // Delete-and-reinsert so the entry's insertion-order position
    // moves to the end (LRU "touch"). JS Maps iterate in insertion
    // order, so this is what gives us LRU eviction semantics.
    this.byCustomer.delete(customerId);
    this.byCustomer.set(customerId, {
      all: entitlements.slice(),
      active: new Set(entitlements.filter((e) => e.isActive).map((e) => e.key)),
      expiresAt: now + this.ttlMs,
      populatedAt: now,
    });
    // Enforce max-customers cap by evicting the oldest entries (head
    // of insertion order = least recently used).
    while (this.byCustomer.size > this.maxCustomers) {
      const oldestKey = this.byCustomer.keys().next().value;
      if (oldestKey === undefined) break;
      this.byCustomer.delete(oldestKey);
      this.evicted += 1;
    }
    this.notify(customerId, entitlements);
  }

  /**
   * Drop a single customer's entry. Fires listeners with an empty
   * list so subscribers know that customer's cache is gone.
   */
  clearCustomer(customerId: string): void {
    if (!this.byCustomer.delete(customerId)) return;
    this.notify(customerId, []);
  }

  /** Wipe the whole cache. Fires listeners for each customer that had a cached entry. */
  clear(): void {
    const customers = [...this.byCustomer.keys()];
    this.byCustomer.clear();
    for (const id of customers) this.notify(id, []);
  }

  /**
   * Subscribe to cache mutations. Returns an unsubscribe function.
   * Listener is invoked AFTER each `setForCustomer` / `clearCustomer`
   * / `clear` call with the affected customer ID + fresh entitlements
   * snapshot. NOT fired on TTL expiry (passive eviction is not a
   * mutation by design).
   *
   * Listener errors are swallowed — a buggy consumer must not crash
   * the SDK or other listeners. The error count is surfaced via
   * `listenerErrors`.
   *
   * Returned unsubscribe is idempotent.
   */
  subscribe(listener: EntitlementsListener): () => void {
    this.listeners.add(listener);
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.listeners.delete(listener);
    };
  }

  // ---------- diagnostics ----------

  /** Total customers currently cached (counts expired entries too — eviction is lazy). */
  get customerCount(): number {
    return this.byCustomer.size;
  }

  /** Most-recent populatedAt across all entries, or 0 if cache empty. */
  get lastUpdated(): number {
    let max = 0;
    for (const entry of this.byCustomer.values()) {
      if (entry.populatedAt > max) max = entry.populatedAt;
    }
    return max;
  }

  /** Configured TTL in ms. */
  get ttl(): number {
    return this.ttlMs;
  }

  /** Cumulative count of listener invocations that threw. Surfaced in `diagnostics()`. */
  get listenerErrors(): number {
    return this.listenerErrorCount;
  }

  /** Cumulative count of entries evicted by the max-customers cap. */
  get evictedCount(): number {
    return this.evicted;
  }

  /** Configured max-customers cap. */
  get maxSize(): number {
    return this.maxCustomers;
  }

  // ---------- internals ----------

  private notify(customerId: string, snapshot: PublicEntitlement[]): void {
    if (this.listeners.size === 0) return;
    const snap = snapshot.slice();
    // Iterate over a snapshot of the listener set so a listener that
    // unsubscribes itself during dispatch doesn't break iteration.
    const listenersSnapshot = [...this.listeners];
    for (const listener of listenersSnapshot) {
      try {
        listener(customerId, snap);
      } catch {
        this.listenerErrorCount += 1;
      }
    }
  }
}
