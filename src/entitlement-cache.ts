/**
 * Per-customer durable last-known-good entitlement cache — the third
 * Crossdeck USP on the server.
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
 * Durability contract (mirrors `@cross-deck/web/src/entitlement-cache.ts`,
 * adapted for a multi-tenant server):
 *   - This cache is NOT a second source of truth. Crossdeck remains the
 *     only source; this is the SDK's local copy of what the server last
 *     told us — a cache that does not forget during a network partition.
 *   - Only a SUCCESSFUL fetch replaces a customer's entry (via
 *     `setForCustomer`). A failed refresh never reaches it, so an outage
 *     can never fail a paying customer down to free.
 *   - **The TTL is a REFRESH HINT, not an invalidation.** `isEntitled()`
 *     and `list()` keep serving last-known-good after `ttlMs` elapses —
 *     they do NOT return `false` / `[]` because the entry aged. The TTL
 *     only drives `needsRefresh()` ("a re-fetch is due") and, with no
 *     failed refresh, the stale flag. This is the central fix: on
 *     serverless a paying customer must not be locked out 60s after a
 *     warm just because Crossdeck was briefly unreachable.
 *   - Staleness alone never returns false. Each entitlement is honoured
 *     against its OWN `validUntil` instead — a time-based trial expiry
 *     still applies even mid-partition; a still-valid Pro entitlement
 *     rides the outage out.
 *   - Staleness is VISIBLE, not silent. `validUntil` covers time-based
 *     expiry; it does NOT cover an event-based revoke (chargeback,
 *     refund, fraud) — that has no `validUntil`, so the cache would keep
 *     serving a revoked customer through an outage. Serving them is the
 *     right trade (don't lock real payers out), but unbounded-and-
 *     invisible is the bug. So once a refresh ATTEMPT fails
 *     (`markRefreshFailed`) or the data ages past `staleAfterMs`, the
 *     customer is flagged stale — `isStale()` / `staleCustomerCount` are
 *     surfaced in `diagnostics()`. It keeps serving last-known-good; the
 *     staleness is just no longer hidden.
 *
 * Cold-start durability lives one layer up: `getEntitlements()` in
 * `crossdeck-server.ts` persists every successful fetch to an optional
 * `EntitlementStore` and, on a network failure, loads last-known-good
 * back from it and into this cache. This cache stays a pure in-memory
 * structure with NO I/O — `isEntitled()` is and remains synchronous.
 *
 * Differences from the web SDK's cache:
 *   - **Per-customer**, not singleton. Web SDK has one user per browser
 *     tab; Node SDK has many users hitting one server. The cache is
 *     keyed by `crossdeckCustomerId`. Staleness, freshness and the
 *     failed-refresh marker are therefore all per-customer too.
 *   - **No synchronous storage hydration** in the constructor. The web
 *     SDK hydrates from `localStorage` on boot; the Node durable store
 *     is async, so hydration happens lazily inside `getEntitlements()`.
 *   - **LRU-bounded** by `maxCustomers` — a long-running multi-tenant
 *     server would otherwise leak Map entries forever.
 *   - **Subscriber API unchanged** — `subscribe(listener)` fires after
 *     any mutation (set / clear). Passive LRU eviction and a TTL
 *     elapsing are NOT mutations, by design.
 */

import type { PublicEntitlement } from "./types";

export type EntitlementsListener = (
  customerId: string,
  entitlements: PublicEntitlement[],
) => void;

interface CacheEntry {
  /**
   * Full entitlement objects (active + inactive). `isEntitled()`
   * iterates these and checks `isActive` + each entitlement's own
   * `validUntil` inline — mirroring the web SDK — so no separate
   * active-key set is kept; that set could not carry `validUntil`.
   */
  all: PublicEntitlement[];
  /**
   * epoch ms after which a re-fetch is DUE. This is a refresh hint, NOT
   * an expiry: past this point `isEntitled()` / `list()` still serve
   * last-known-good. It only drives `needsRefresh()` and the stale flag.
   */
  refreshDueAt: number;
  /** epoch ms the entry was last populated by a successful fetch. */
  populatedAt: number;
  /**
   * epoch ms of the most recent FAILED refresh attempt for this
   * customer, or 0 if the last attempt succeeded. Set by
   * `markRefreshFailed`, cleared by `setForCustomer`. When this is more
   * recent than `populatedAt` the customer is knowingly stale.
   */
  refreshFailedAt: number;
}

export interface EntitlementCacheOptions {
  /**
   * Refresh-hint TTL in ms. Default 60_000 (60s).
   *
   * After `ttlMs` a customer's entry is "refresh due" — `needsRefresh()`
   * returns true and the caller should re-fetch. It is NOT an expiry:
   * `isEntitled()` keeps serving last-known-good past it. `0` makes
   * every entry immediately refresh-due (useful for tests) but STILL
   * does not invalidate — last-known-good is served regardless.
   */
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
  /**
   * Age (ms) past which a customer's last-known-good data is flagged
   * STALE even with no failed refresh. Default 24h.
   *
   * Staleness never changes what `isEntitled()` returns; it only makes a
   * long un-refreshed window observable via `isStale()` / diagnostics —
   * so an event-based revoke (no `validUntil`) riding out an outage is
   * visible instead of silent.
   */
  staleAfterMs?: number;
}

const DEFAULT_MAX_CUSTOMERS = 10_000;
/** Default staleness window — data older than this is flagged even with no failed refresh. */
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h

export class EntitlementCache {
  private readonly ttlMs: number;
  private readonly maxCustomers: number;
  private readonly staleAfterMs: number;
  private byCustomer = new Map<string, CacheEntry>();
  private listeners = new Set<EntitlementsListener>();
  private listenerErrorCount = 0;
  private evicted = 0;

  constructor(options: EntitlementCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxCustomers = options.maxCustomers ?? DEFAULT_MAX_CUSTOMERS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  /**
   * Synchronous lookup — true iff the customer currently has the
   * entitlement granting access. Pure in-memory `Map` read, ZERO I/O.
   *
   * Served from last-known-good: a stale entry (Crossdeck unreachable
   * since the last successful fetch, or past `ttlMs`) STILL answers true
   * for a still-valid entitlement. Cache staleness alone never makes
   * this `false` — the central durability fix. The only things that
   * turn it false:
   *   - the customer has no cached entry at all (genuine cold miss)
   *   - no matching `key` in the customer's entitlement set
   *   - the matching entitlement is `isActive: false`
   *   - the matching entitlement is past its OWN `validUntil` — a
   *     time-based trial expiry still applies mid-outage (mirrors the
   *     web SDK's `validUntil` check exactly).
   *
   * An entry being past `ttlMs`, or marked refresh-failed, does NOT
   * affect the answer — `getEntitlements()` re-fetches on the TTL hint,
   * but until it succeeds the customer keeps their access.
   */
  isEntitled(customerId: string, key: string): boolean {
    const entry = this.byCustomer.get(customerId);
    if (!entry) return false;
    const nowSec = Date.now() / 1000;
    return entry.all.some(
      (e) =>
        e.key === key &&
        e.isActive &&
        (e.validUntil == null || e.validUntil > nowSec),
    );
  }

  /**
   * Full snapshot for callers that need source / validUntil details.
   * Returns `[]` ONLY when the customer has no cached entry — a stale
   * or past-TTL entry still returns its last-known-good entitlements
   * (same durability posture as `isEntitled()`; per-entitlement
   * `validUntil` is the caller's to honour from the returned objects).
   */
  list(customerId: string): PublicEntitlement[] {
    const entry = this.byCustomer.get(customerId);
    if (!entry) return [];
    return entry.all.slice();
  }

  /**
   * Whether the customer's entry is still within `ttlMs` — i.e. a
   * re-fetch is NOT yet due. Useful for deciding whether to warm before
   * a hot path. A `false` result does NOT mean the cache is empty or
   * that `isEntitled()` will return false — it only means the data is
   * past its refresh hint. See `needsRefresh()` for the inverse.
   */
  isFresh(customerId: string): boolean {
    const entry = this.byCustomer.get(customerId);
    return Boolean(entry && Date.now() <= entry.refreshDueAt);
  }

  /**
   * Whether the customer should be re-fetched: either there is no
   * cached entry, or the entry is past its `ttlMs` refresh hint, or the
   * most recent refresh attempt for them failed (retry it).
   *
   * This is purely advisory — `getEntitlements()` decides when to act
   * on it. It NEVER gates `isEntitled()`, which serves last-known-good
   * regardless.
   */
  needsRefresh(customerId: string): boolean {
    const entry = this.byCustomer.get(customerId);
    if (!entry) return true;
    // A non-zero failure stamp means a refresh failed since the last
    // success (setForCustomer zeroes it) — retry it.
    if (entry.refreshFailedAt > 0) return true;
    return Date.now() > entry.refreshDueAt;
  }

  /**
   * Replace (or insert) the cache entry for a customer with a fresh
   * server response. Sets `refreshDueAt` to `now + ttlMs` and CLEARS
   * any failed-refresh marker — a success ends the stale state.
   *
   * Called ONLY after a SUCCESSFUL server read — a failed fetch is
   * routed to `markRefreshFailed` instead and never reaches here, so
   * last-known-good is preserved through an outage.
   *
   * Re-inserting an existing customerId "touches" it — the entry moves
   * to the end of insertion order (Map semantics) so it's treated as
   * most-recently-used for LRU eviction. Fires listeners.
   */
  setForCustomer(customerId: string, entitlements: PublicEntitlement[]): void {
    const now = Date.now();
    // Delete-and-reinsert so the entry's insertion-order position
    // moves to the end (LRU "touch"). JS Maps iterate in insertion
    // order, so this is what gives us LRU eviction semantics.
    this.byCustomer.delete(customerId);
    this.byCustomer.set(customerId, {
      all: entitlements.slice(),
      refreshDueAt: now + this.ttlMs,
      populatedAt: now,
      refreshFailedAt: 0,
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
   * Record that a refresh attempt for a customer FAILED (Crossdeck
   * unreachable / transient error). `getEntitlements()` calls this in
   * its catch path.
   *
   * It does NOT touch the customer's cached entitlements — last-known-
   * good keeps serving — it only stamps `refreshFailedAt` so the
   * customer shows up as stale in `diagnostics()` rather than the
   * staleness being a silent unbounded window.
   *
   * If the customer has no entry yet (a genuine cold miss whose first
   * fetch failed) a stub entry with no entitlements is created purely
   * to carry the failed-refresh marker — so "we tried and Crossdeck was
   * down" is observable even before any successful warm. The stub holds
   * an empty entitlement set, so `isEntitled()` still correctly returns
   * false for it; there is genuinely nothing to serve.
   */
  markRefreshFailed(customerId: string): void {
    const now = Date.now();
    const entry = this.byCustomer.get(customerId);
    if (entry) {
      entry.refreshFailedAt = now;
      return;
    }
    // Cold miss whose first refresh failed — create a marker-only stub.
    // Not an LRU "touch" of real data, but it IS an entry, so it counts
    // toward the cap; eviction order treats it like any other.
    this.byCustomer.set(customerId, {
      all: [],
      refreshDueAt: now + this.ttlMs,
      populatedAt: 0,
      refreshFailedAt: now,
    });
    while (this.byCustomer.size > this.maxCustomers) {
      const oldestKey = this.byCustomer.keys().next().value;
      if (oldestKey === undefined) break;
      this.byCustomer.delete(oldestKey);
      this.evicted += 1;
    }
  }

  /**
   * Whether a customer is knowingly serving older-than-trustworthy
   * data. True when the most recent refresh ATTEMPT for them failed
   * (Crossdeck unreachable since the last success — the outage case,
   * distinct from a benign idle customer simply past `ttlMs`), OR when
   * their last-known-good has aged past `staleAfterMs`.
   *
   * `isStale` NEVER changes what `isEntitled()` returns — the cache
   * still serves last-known-good. It exists so the staleness is
   * observable via `diagnostics()` instead of an unbounded silent
   * window where a revoked customer (event-based revoke, no
   * `validUntil`) holds access with nobody able to see it.
   *
   * Returns false for an unknown customer — nothing cached, nothing
   * stale.
   */
  isStale(customerId: string): boolean {
    const entry = this.byCustomer.get(customerId);
    if (!entry) return false;
    return this.entryIsStale(entry);
  }

  /** Epoch ms of a customer's last failed refresh, or 0 if none / unknown. */
  refreshFailedAt(customerId: string): number {
    return this.byCustomer.get(customerId)?.refreshFailedAt ?? 0;
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

  /** Configured staleness window in ms. */
  get staleWindowMs(): number {
    return this.staleAfterMs;
  }

  /**
   * Count of cached customers currently flagged stale — most recent
   * refresh failed, or data aged past `staleAfterMs`. The cache keeps
   * serving last-known-good for them; this is the observability number
   * `diagnostics()` surfaces.
   */
  get staleCustomerCount(): number {
    let count = 0;
    for (const entry of this.byCustomer.values()) {
      if (this.entryIsStale(entry)) count += 1;
    }
    return count;
  }

  /** Whether ANY cached customer is currently stale. */
  get isAnyStale(): boolean {
    for (const entry of this.byCustomer.values()) {
      if (this.entryIsStale(entry)) return true;
    }
    return false;
  }

  /**
   * Most recent failed-refresh timestamp across all customers (epoch
   * ms), or 0 if every cached customer's last refresh succeeded.
   */
  get lastRefreshFailedAt(): number {
    let max = 0;
    for (const entry of this.byCustomer.values()) {
      if (entry.refreshFailedAt > max) max = entry.refreshFailedAt;
    }
    return max;
  }

  // ---------- internals ----------

  /**
   * Stale iff the entry's most recent refresh attempt failed, OR its
   * last-known-good has aged past `staleAfterMs`.
   *
   * `refreshFailedAt` is non-zero ONLY between a failed refresh and the
   * next successful one (`setForCustomer` zeroes it), so `> 0` alone
   * means "a failure occurred since the last success" — no need to
   * compare against `populatedAt`, which would mis-fire when a failure
   * and a populate land in the same millisecond. A marker-only stub
   * (populatedAt 0, failure stamped) is stale via this first clause.
   */
  private entryIsStale(entry: CacheEntry): boolean {
    if (entry.refreshFailedAt > 0) return true;
    return (
      entry.populatedAt > 0 &&
      Date.now() - entry.populatedAt > this.staleAfterMs
    );
  }

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
