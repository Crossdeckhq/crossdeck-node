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

describe("EntitlementCache — TTL behaviour", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cache hit while fresh — no expiry within TTL", () => {
    const c = new EntitlementCache({ ttlMs: 60_000 });
    c.setForCustomer("cdcust_x", [entitlement("pro")]);
    expect(c.isEntitled("cdcust_x", "pro")).toBe(true);
  });

  it("after TTL elapses → isEntitled returns false (expired entry treated as cold)", () => {
    vi.useFakeTimers();
    const c = new EntitlementCache({ ttlMs: 1000 });
    c.setForCustomer("cdcust_x", [entitlement("pro")]);
    vi.advanceTimersByTime(1500);
    expect(c.isEntitled("cdcust_x", "pro")).toBe(false);
  });

  it("isFresh reflects entry state through expiration", () => {
    vi.useFakeTimers();
    const c = new EntitlementCache({ ttlMs: 1000 });
    expect(c.isFresh("cdcust_x")).toBe(false);
    c.setForCustomer("cdcust_x", [entitlement("pro")]);
    expect(c.isFresh("cdcust_x")).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(c.isFresh("cdcust_x")).toBe(false);
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
