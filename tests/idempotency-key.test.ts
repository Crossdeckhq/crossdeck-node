// Phase 2.2 contract tests — Node-side mirror.
//
// The Node implementation uses node:crypto under the hood; the
// observable output MUST match the web/RN implementations
// byte-identically so the backend sees the same key from any
// SDK for the same transaction.

import { describe, it, expect } from "vitest";
import {
  deriveIdempotencyKeyForPurchase,
  formatAsUuid,
} from "../src/idempotency-key";

describe("deriveIdempotencyKeyForPurchase (Node)", () => {
  it("is deterministic", () => {
    const body = {
      rail: "apple",
      signedTransactionInfo: "eyJ.jws.sig",
    };
    expect(deriveIdempotencyKeyForPurchase(body)).toBe(
      deriveIdempotencyKeyForPurchase(body),
    );
  });

  it("returns UUID-shaped string", () => {
    const key = deriveIdempotencyKeyForPurchase({
      rail: "apple",
      signedTransactionInfo: "eyJ.jws.sig",
    });
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("different signedTransactionInfo -> different key", () => {
    const a = deriveIdempotencyKeyForPurchase({
      rail: "apple",
      signedTransactionInfo: "eyJ.first.jws",
    });
    const b = deriveIdempotencyKeyForPurchase({
      rail: "apple",
      signedTransactionInfo: "eyJ.second.jws",
    });
    expect(a).not.toBe(b);
  });

  it("derives Google rail from purchaseToken", () => {
    const a = deriveIdempotencyKeyForPurchase({
      rail: "google",
      purchaseToken: "play-token-abc",
    });
    const b = deriveIdempotencyKeyForPurchase({
      rail: "google",
      purchaseToken: "play-token-abc",
    });
    expect(a).toBe(b);
  });

  it("rail namespacing prevents cross-rail collisions", () => {
    const apple = deriveIdempotencyKeyForPurchase({
      rail: "apple",
      signedTransactionInfo: "shared-bytes",
    });
    const google = deriveIdempotencyKeyForPurchase({
      rail: "google",
      purchaseToken: "shared-bytes",
    });
    expect(apple).not.toBe(google);
  });

  it("throws on missing identifier (never silent fallback)", () => {
    expect(() => deriveIdempotencyKeyForPurchase({ rail: "apple" })).toThrow();
    expect(() => deriveIdempotencyKeyForPurchase({ rail: "google" })).toThrow();
  });
});

describe("formatAsUuid (Node)", () => {
  it("formats 32 hex chars as 8-4-4-4-12", () => {
    expect(formatAsUuid("0123456789abcdef0123456789abcdef")).toBe(
      "01234567-89ab-cdef-0123-456789abcdef",
    );
  });
});

// Cross-SDK parity oracle: the same input MUST produce the same key
// across Web/Node/RN. Hard-coded vector here; matching tests in the
// web and RN suites verify their derivations land on the same value.
describe("cross-SDK parity oracle", () => {
  it("apple JWS produces the canonical pinned UUID across all 5 SDKs", () => {
    // The vector below MUST match the assertions in:
    //   sdks/web/tests/idempotency-key.test.ts
    //   sdks/react-native/tests/idempotency-key.test.ts
    //   sdks/swift/Tests/CrossdeckTests/IdempotencyKeyTests.swift
    //   sdks/android/crossdeck/src/test/kotlin/com/crossdeck/IdempotencyKeyTest.kt
    // Pin computed via:
    //   node -e "const c=require('crypto');console.log(c.createHash('sha256').update('crossdeck:purchases/sync:apple:eyJ.jws.sig').digest('hex'))"
    // A regression here breaks the wire-protocol parity Stripe-grade
    // idempotency depends on.
    const key = deriveIdempotencyKeyForPurchase({
      rail: "apple",
      signedTransactionInfo: "eyJ.jws.sig",
    });
    expect(key).toBe("a66b1640-efaf-bb4d-1261-6650033bf111");
  });
});
