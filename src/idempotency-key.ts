/**
 * Deterministic Idempotency-Key derivation for /purchases/sync.
 *
 * Phase 2.2 of bank-grade reconciliation v1.4.0. Node variant —
 * uses `node:crypto.createHash` instead of the pure-JS sha256
 * the browser SDKs ship; algorithm + output are byte-identical
 * to `sdks/web/src/idempotency-key.ts`.
 *
 * Same input → same key → backend returns the cached response
 * with `idempotent_replay: true` instead of double-processing.
 */

import { createHash } from "node:crypto";

export interface PurchaseSyncIdentity {
  rail: "apple" | "google" | "stripe" | string;
  signedTransactionInfo?: string;
  purchaseToken?: string;
}

export function formatAsUuid(hex: string): string {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function deriveIdempotencyKeyForPurchase(body: PurchaseSyncIdentity): string {
  let identifier: string;
  if (body.rail === "apple") {
    identifier = body.signedTransactionInfo ?? "";
  } else if (body.rail === "google") {
    identifier = body.purchaseToken ?? "";
  } else {
    identifier = "";
  }
  if (!identifier) {
    throw new Error(
      `deriveIdempotencyKeyForPurchase: no stable identifier in body ` +
        `(rail=${body.rail}). Apple needs signedTransactionInfo; ` +
        `Google needs purchaseToken.`,
    );
  }
  const namespaced = `crossdeck:purchases/sync:${body.rail}:${identifier}`;
  return formatAsUuid(sha256Hex(namespaced));
}
