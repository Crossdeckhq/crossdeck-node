import { describe, expect, it } from "vitest";

import { RetryPolicy, computeNextDelay } from "../src/retry-policy";

describe("computeNextDelay (pure)", () => {
  it("attempt 0 with deterministic RNG=0.5 → 500ms (jittered 0-1000)", () => {
    expect(computeNextDelay(0, undefined, {}, () => 0.5)).toBe(500);
  });

  it("attempt 3 with deterministic RNG=1 → 8000ms (ceiling = base * 2^3)", () => {
    expect(computeNextDelay(3, undefined, {}, () => 1)).toBe(8000);
  });

  it("attempt 0 with Retry-After 30_000 → server wins (30_000)", () => {
    expect(computeNextDelay(0, 30_000, {}, () => 0.5)).toBe(30_000);
  });

  it("attempt 30 — capped at maxMs (60_000) — 2^30 must not overflow", () => {
    expect(computeNextDelay(30, undefined, {}, () => 1)).toBe(60_000);
  });

  it("Retry-After smaller than computed jittered delay → computed wins", () => {
    // attempts=3, ceiling=8000, rng=1 → jittered=8000; retryAfter=100 < 8000 → computed.
    expect(computeNextDelay(3, 100, {}, () => 1)).toBe(8000);
  });

  it("never returns a negative delay", () => {
    expect(computeNextDelay(0, undefined, {}, () => 0)).toBeGreaterThanOrEqual(0);
  });
});

describe("RetryPolicy", () => {
  it("nextDelay() increments the consecutive-failure counter", () => {
    const p = new RetryPolicy();
    expect(p.consecutiveFailures).toBe(0);
    p.nextDelay(undefined, () => 0.5);
    expect(p.consecutiveFailures).toBe(1);
    p.nextDelay(undefined, () => 0.5);
    expect(p.consecutiveFailures).toBe(2);
  });

  it("recordSuccess() resets the counter to 0", () => {
    const p = new RetryPolicy();
    p.nextDelay();
    p.nextDelay();
    p.nextDelay();
    p.recordSuccess();
    expect(p.consecutiveFailures).toBe(0);
  });

  it("isWarning flips at failuresBeforeWarn threshold (default 8)", () => {
    const p = new RetryPolicy();
    for (let i = 0; i < 7; i++) p.nextDelay();
    expect(p.isWarning).toBe(false);
    p.nextDelay();
    expect(p.isWarning).toBe(true);
  });
});
