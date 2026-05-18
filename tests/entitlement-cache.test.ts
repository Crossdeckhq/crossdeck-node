import { afterEach, describe, expect, it, vi } from "vitest";

import { EntitlementCache } from "../src/entitlement-cache";
import type { PublicEntitlement } from "../src/types";

function entitlement(key: string, isActive = true): PublicEntitlement {
  return {
    object: "entitlement",
    key,
    isActive,
    validUntil: null,
    source: { rail: "manual", productId: "p", subscriptionId: "s" },
    updatedAt: Date.now(),
  };
}

describe("EntitlementCache — basic lookup", () => {
  it("pre-warm: isEntitled returns false", () => {
    const c = new EntitlementCache();
    expect(c.isEntitled("cdcust_x", "pro")).toBe(false);
  });

  it("after setForCustomer with active 'pro' → isEntitled returns true", () => {
    const c = new EntitlementCache();
    c.setForCustomer("cdcust_x", [entitlement("pro")]);
    expect(c.isEntitled("cdcust_x", "pro")).toBe(true);
  });

  it("setForCustomer with INACTIVE 'pro' → isEntitled returns false", () => {
    const c = new EntitlementCache();
    c.setForCustomer("cdcust_x", [entitlement("pro", false)]);
    expect(c.isEntitled("cdcust_x", "pro")).toBe(false);
  });
});

describe("EntitlementCache — TTL is a refresh hint, not an invalidation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cache hit while fresh — no expiry within TTL", () => {
    const c = new EntitlementCache({ ttlMs: 60_000 });
    c.setForCustomer("cdcust_x", [entitlement("pro")]);
    expect(c.isEntitled("cdcust_x", "pro")).toBe(true);
  });

  it("after TTL elapses → isEntitled STILL returns true (serves last-known-good)", () => {
    vi.useFakeTimers();
    const c = new EntitlementCache({ ttlMs: 1000 });
    c.setForCustomer("cdcust_x", [entitlement("pro")]);
    vi.advanceTimersByTime(60_000);
    // The TTL is only a refresh hint — a past-TTL entry keeps serving.
    // An outage can never flip a paying customer to false.
    expect(c.isEntitled("cdcust_x", "pro")).toBe(true);
    expect(c.list("cdcust_x")).toHaveLength(1);
  });

  it("isEntitled honours each entitlement's OWN validUntil even mid-outage", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));
    const c = new EntitlementCache({ ttlMs: 1000 });
    const nowSec = Date.now() / 1000;
    const trial: PublicEntitlement = {
      object: "entitlement",
      key: "pro",
      isActive: true,
      validUntil: nowSec + 3600, // expires in 1h
      source: { rail: "manual", productId: "p", subscriptionId: "s" },
      updatedAt: Date.now(),
    };
    c.setForCustomer("cdcust_x", [trial]);
    // Within validUntil — entitled even though the TTL elapsed.
    vi.advanceTimersByTime(30 * 60_000);
    expect(c.isEntitled("cdcust_x", "pro")).toBe(true);
    // Past validUntil — the trial expiry still applies, no longer entitled.
    vi.advanceTimersByTime(60 * 60_000);
    expect(c.isEntitled("cdcust_x", "pro")).toBe(false);
  });

  it("isFresh reflects the refresh-hint window (false past TTL)", () => {
    vi.useFakeTimers();
    const c = new EntitlementCache({ ttlMs: 1000 });
    expect(c.isFresh("cdcust_x")).toBe(false);
    c.setForCustomer("cdcust_x", [entitlement("pro")]);
    expect(c.isFresh("cdcust_x")).toBe(true);
    vi.advanceTimersByTime(1500);
    // isFresh is now false — a re-fetch is DUE — but isEntitled stays true.
    expect(c.isFresh("cdcust_x")).toBe(false);
    expect(c.needsRefresh("cdcust_x")).toBe(true);
    expect(c.isEntitled("cdcust_x", "pro")).toBe(true);
  });
});

describe("EntitlementCache — staleness signal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("markRefreshFailed flags a warm customer stale without changing isEntitled", () => {
    const c = new EntitlementCache();
    c.setForCustomer("cdcust_x", [entitlement("pro")]);
    expect(c.isStale("cdcust_x")).toBe(false);
    c.markRefreshFailed("cdcust_x");
    expect(c.isStale("cdcust_x")).toBe(true);
    // Staleness NEVER changes the answer — last-known-good keeps serving.
    expect(c.isEntitled("cdcust_x", "pro")).toBe(true);
  });

  it("a later successful refresh clears the stale flag", () => {
    const c = new EntitlementCache();
    c.setForCustomer("cdcust_x", [entitlement("pro")]);
    c.markRefreshFailed("cdcust_x");
    expect(c.isStale("cdcust_x")).toBe(true);
    c.setForCustomer("cdcust_x", [entitlement("pro")]);
    expect(c.isStale("cdcust_x")).toBe(false);
  });

  it("markRefreshFailed on a cold miss creates a marker-only stub (stale, not entitled)", () => {
    const c = new EntitlementCache();
    c.markRefreshFailed("cdcust_new");
    expect(c.isStale("cdcust_new")).toBe(true);
    // Nothing to serve — the stub has an empty entitlement set.
    expect(c.isEntitled("cdcust_new", "pro")).toBe(false);
  });

  it("data aged past staleAfterMs is flagged stale even with no failed refresh", () => {
    vi.useFakeTimers();
    const c = new EntitlementCache({ ttlMs: 1000, staleAfterMs: 10_000 });
    c.setForCustomer("cdcust_x", [entitlement("pro")]);
    vi.advanceTimersByTime(5_000);
    expect(c.isStale("cdcust_x")).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(c.isStale("cdcust_x")).toBe(true);
    // Still serving last-known-good.
    expect(c.isEntitled("cdcust_x", "pro")).toBe(true);
  });

  it("aggregate diagnostics — staleCustomerCount, isAnyStale, lastRefreshFailedAt", () => {
    const c = new EntitlementCache();
    c.setForCustomer("cdcust_x", [entitlement("pro")]);
    c.setForCustomer("cdcust_y", [entitlement("pro")]);
    expect(c.staleCustomerCount).toBe(0);
    expect(c.isAnyStale).toBe(false);
    expect(c.lastRefreshFailedAt).toBe(0);
    c.markRefreshFailed("cdcust_y");
    expect(c.staleCustomerCount).toBe(1);
    expect(c.isAnyStale).toBe(true);
    expect(c.lastRefreshFailedAt).toBeGreaterThan(0);
  });
});

describe("EntitlementCache — list snapshots", () => {
  it("list(customerId) returns the full snapshot (active + inactive)", () => {
    const c = new EntitlementCache();
    const ents = [entitlement("pro"), entitlement("team", false)];
    c.setForCustomer("cdcust_x", ents);
    expect(c.list("cdcust_x")).toHaveLength(2);
  });

  it("list() returns defensive copy — mutating it does not affect cache", () => {
    const c = new EntitlementCache();
    c.setForCustomer("cdcust_x", [entitlement("pro")]);
    const snap = c.list("cdcust_x");
    snap.push(entitlement("forged"));
    expect(c.list("cdcust_x")).toHaveLength(1);
  });
});

describe("EntitlementCache — listener API", () => {
  it("subscribe(listener) fires after setForCustomer with (customerId, snapshot)", () => {
    const c = new EntitlementCache();
    const calls: Array<{ id: string; n: number }> = [];
    c.subscribe((id, ents) => calls.push({ id, n: ents.length }));
    c.setForCustomer("cdcust_x", [entitlement("pro")]);
    expect(calls).toEqual([{ id: "cdcust_x", n: 1 }]);
  });

  it("subscribe fires on clearCustomer with empty list", () => {
    const c = new EntitlementCache();
    c.setForCustomer("cdcust_x", [entitlement("pro")]);
    const calls: number[] = [];
    c.subscribe((_, ents) => calls.push(ents.length));
    c.clearCustomer("cdcust_x");
    expect(calls).toEqual([0]);
  });

  it("listener errors are swallowed and increment listenerErrors counter", () => {
    const c = new EntitlementCache();
    c.subscribe(() => {
      throw new Error("listener crashed");
    });
    expect(() => c.setForCustomer("cdcust_x", [])).not.toThrow();
    expect(c.listenerErrors).toBe(1);
  });

  it("unsubscribe is idempotent — calling twice is safe", () => {
    const c = new EntitlementCache();
    const unsub = c.subscribe(() => undefined);
    expect(() => {
      unsub();
      unsub();
    }).not.toThrow();
  });
});

describe("EntitlementCache — diagnostics surface", () => {
  it("customerCount + lastUpdated + ttl reflect runtime state", () => {
    const c = new EntitlementCache({ ttlMs: 30_000 });
    expect(c.customerCount).toBe(0);
    expect(c.ttl).toBe(30_000);
    c.setForCustomer("cdcust_x", [entitlement("pro")]);
    c.setForCustomer("cdcust_y", [entitlement("pro")]);
    expect(c.customerCount).toBe(2);
    expect(c.lastUpdated).toBeGreaterThan(0);
  });

  it("clear() removes all entries and fires listeners for each", () => {
    const c = new EntitlementCache();
    c.setForCustomer("cdcust_x", [entitlement("pro")]);
    c.setForCustomer("cdcust_y", [entitlement("team")]);
    const seen = new Set<string>();
    c.subscribe((id) => seen.add(id));
    c.clear();
    expect(c.customerCount).toBe(0);
    expect(seen.size).toBe(2);
  });
});

describe("EntitlementCache — LRU eviction (bank-grade memory bound)", () => {
  it("maxCustomers cap evicts the OLDEST entry when exceeded (FIFO by default)", () => {
    const c = new EntitlementCache({ maxCustomers: 3 });
    c.setForCustomer("cdcust_a", [entitlement("pro")]);
    c.setForCustomer("cdcust_b", [entitlement("pro")]);
    c.setForCustomer("cdcust_c", [entitlement("pro")]);
    expect(c.customerCount).toBe(3);
    expect(c.evictedCount).toBe(0);

    // Adding a 4th evicts cdcust_a (oldest).
    c.setForCustomer("cdcust_d", [entitlement("pro")]);
    expect(c.customerCount).toBe(3);
    expect(c.evictedCount).toBe(1);
    expect(c.isEntitled("cdcust_a", "pro")).toBe(false);
    expect(c.isEntitled("cdcust_d", "pro")).toBe(true);
  });

  it("re-inserting an existing customerId touches it (LRU) — the touched entry is NOT evicted next", () => {
    const c = new EntitlementCache({ maxCustomers: 3 });
    c.setForCustomer("cdcust_a", [entitlement("pro")]);
    c.setForCustomer("cdcust_b", [entitlement("pro")]);
    c.setForCustomer("cdcust_c", [entitlement("pro")]);

    // Touch cdcust_a — moves it to most-recently-used position.
    c.setForCustomer("cdcust_a", [entitlement("pro")]);

    // Adding a 4th should now evict cdcust_b (the oldest after the touch).
    c.setForCustomer("cdcust_d", [entitlement("pro")]);
    expect(c.isEntitled("cdcust_a", "pro")).toBe(true);
    expect(c.isEntitled("cdcust_b", "pro")).toBe(false);
    expect(c.isEntitled("cdcust_c", "pro")).toBe(true);
    expect(c.isEntitled("cdcust_d", "pro")).toBe(true);
  });

  it("maxSize getter reflects the configured cap", () => {
    expect(new EntitlementCache({ maxCustomers: 42 }).maxSize).toBe(42);
    expect(new EntitlementCache().maxSize).toBe(10_000); // default
  });
});
