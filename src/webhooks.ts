/**
 * Webhook signature verification — Stripe pattern.
 *
 * **[ROADMAP — v1.4.0 honesty note]:** Crossdeck does NOT yet send
 * outbound webhooks. Outbound delivery (signer + worker + scheduler
 * + dead-letter dashboard) is on the post-v1.5 roadmap. This
 * verifier exists today so customer-side integration code can be
 * written and tested against fixtures (use `signWebhookPayload`
 * to produce signed bodies for your local tests), and so the
 * verification contract surface is locked in BEFORE delivery
 * ships — Phase 7.2 of the bank-grade reconciliation tightened
 * the timestamp-validation footguns here precisely because the
 * helper IS the contract surface for inbound validation,
 * regardless of when first-party delivery lights up.
 *
 * Lets customers verify the events Crossdeck sends to THEM (when
 * delivery ships). Table-stakes for any backend SDK (Stripe ships
 * `Stripe.webhooks.constructEvent()` from day one, Svix ships
 * `Webhook.verify()` from day one).
 *
 * Wire format:
 *   Header `Crossdeck-Signature: t=<unix-seconds>,v1=<hex>`
 *   Where `v1` is HMAC-SHA256(secret, `${t}.${payload}`) — Stripe-compatible.
 *
 * Customers receive a signing secret from the Crossdeck dashboard
 * (one-time reveal at mint time; rotated as needed). Each webhook
 * carries the signature header above. The customer's handler:
 *
 *   import { verifyWebhookSignature } from "@cross-deck/node";
 *
 *   app.post("/crossdeck-webhook", express.raw({ type: "application/json" }), (req, res) => {
 *     try {
 *       const event = verifyWebhookSignature(
 *         req.body.toString("utf8"),
 *         req.headers["crossdeck-signature"],
 *         process.env.CROSSDECK_WEBHOOK_SECRET,
 *       );
 *       // event is the parsed JSON payload
 *       handleCrossdeckEvent(event);
 *       res.sendStatus(200);
 *     } catch (err) {
 *       res.sendStatus(401);
 *     }
 *   });
 *
 * The signing scheme is constant-time via `crypto.timingSafeEqual` so
 * a malicious caller can't extract the signature by measuring response
 * timing. Replay defence: timestamps older than `replayToleranceMs`
 * (default 5 min) are rejected — required because HMAC-SHA256 is
 * stateless and would otherwise allow an attacker to replay an old
 * webhook indefinitely.
 *
 * Supports multiple secrets for rotation: pass an array; the helper
 * tries each, accepts on the first match. Lets customers rotate the
 * dashboard secret without dropping in-flight webhooks.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { CrossdeckError } from "./errors";

export interface VerifyWebhookOptions {
  /**
   * Maximum age of the webhook timestamp in milliseconds. Default
   * 5 minutes (`DEFAULT_REPLAY_TOLERANCE_MS`). Anything older than
   * this is rejected as a replay.
   *
   * **v1.4.0 Phase 7.2 bank-grade contract:** the timestamp window
   * is MANDATORY. Pre-v1.4.0 the helper accepted `tolerance: 0`
   * (silently disables the check) and `tolerance: Infinity` /
   * `null` / `NaN` (silently disables via `Math.abs(...) > Infinity
   * = false`). Customers relying on replay protection silently
   * lost it.
   *
   * The helper now rejects non-finite / negative / above-cap
   * tolerances at the boundary with a typed
   * `webhook_invalid_tolerance` error. Hard upper bound is 24h —
   * sufficient for any plausible clock-skew scenario, prevents
   * "Infinity by typo" from defeating replay protection.
   */
  replayToleranceMs?: number;
  /**
   * Override the current time. Tests use this to verify timestamp
   * handling deterministically. Defaults to `Date.now()`.
   */
  now?: () => number;
}

const DEFAULT_REPLAY_TOLERANCE_MS = 5 * 60 * 1000;
/** Hard upper bound on tolerance — 24h. Prevents an Infinity /
 * sky-high value from silently disabling replay protection. */
const MAX_REPLAY_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * Verify a Crossdeck-signed webhook. Returns the parsed JSON payload
 * on success. Throws `CrossdeckError` with one of these
 * distinguishable codes (v1.4.0 Phase 7.2 — pre-v1.4.0 conflated
 * everything under `webhook_invalid_signature`; alerting can now
 * separate replay-attack signals from wrong-secret signals):
 *   - `webhook_missing_secret` — no secret configured.
 *   - `webhook_invalid_tolerance` — caller passed Infinity / NaN /
 *     negative / above-24h-cap `replayToleranceMs`.
 *   - `webhook_timestamp_missing` — header absent or has no `t=`.
 *   - `webhook_timestamp_outside_tolerance` — drift > tolerance
 *     (replay-attack signal — split this from signature mismatch
 *     in your alerting rules).
 *   - `webhook_signature_mismatch` — HMAC didn't match any
 *     configured secret (wrong-secret / rotation-drift signal).
 *   - `webhook_payload_not_json` — signature verified but the body
 *     isn't parseable JSON (tampered post-signing or source bug).
 *
 * `secret` accepts a single string or an array of strings (for
 * rotation). Any one match is sufficient.
 */
export function verifyWebhookSignature(
  payload: string,
  signatureHeader: string | string[] | undefined,
  secret: string | string[] | undefined,
  options: VerifyWebhookOptions = {},
): unknown {
  const secrets = normaliseSecrets(secret);
  if (secrets.length === 0) {
    throw new CrossdeckError({
      type: "configuration_error",
      code: "webhook_missing_secret",
      message:
        "verifyWebhookSignature requires a non-empty secret. Read it from process.env.CROSSDECK_WEBHOOK_SECRET — never hardcode in source.",
    });
  }

  // v1.4.0 Phase 7.2 — validate tolerance at the boundary BEFORE
  // any other work. Non-finite / negative / above-cap values
  // would silently disable replay protection in the pre-1.4.0
  // helper (Math.abs(...) > Infinity = false). Reject loudly.
  const requestedTolerance = options.replayToleranceMs;
  let tolerance: number;
  if (requestedTolerance === undefined) {
    tolerance = DEFAULT_REPLAY_TOLERANCE_MS;
  } else if (typeof requestedTolerance !== "number" || !Number.isFinite(requestedTolerance)) {
    throw new CrossdeckError({
      type: "configuration_error",
      code: "webhook_invalid_tolerance",
      message:
        `replayToleranceMs must be a finite non-negative number ≤ ${MAX_REPLAY_TOLERANCE_MS} (24h). ` +
        `Got: ${String(requestedTolerance)}. Pre-v1.4.0 accepted Infinity/NaN/null and silently disabled replay protection — v1.4.0 rejects loudly.`,
    });
  } else if (requestedTolerance < 0) {
    throw new CrossdeckError({
      type: "configuration_error",
      code: "webhook_invalid_tolerance",
      message: `replayToleranceMs must be ≥ 0. Got ${requestedTolerance}.`,
    });
  } else if (requestedTolerance > MAX_REPLAY_TOLERANCE_MS) {
    throw new CrossdeckError({
      type: "configuration_error",
      code: "webhook_invalid_tolerance",
      message:
        `replayToleranceMs must not exceed ${MAX_REPLAY_TOLERANCE_MS}ms (24h). ` +
        `Got ${requestedTolerance}ms — a window that wide defeats replay protection.`,
    });
  } else {
    tolerance = requestedTolerance;
  }

  const header = normaliseHeader(signatureHeader);
  const parsed = parseSignatureHeader(header);
  if (!parsed) {
    // The header was either absent or missing the `t=` timestamp
    // segment — both make the timestamp gate unverifiable. Surface
    // as `webhook_timestamp_missing` so alerting can distinguish
    // tampered/missing headers from genuine signature mismatches.
    throw new CrossdeckError({
      type: "authentication_error",
      code: "webhook_timestamp_missing",
      message:
        "Webhook signature header is missing, malformed, or has no `t=` timestamp segment. " +
        "Expected 'Crossdeck-Signature: t=<unix>,v1=<hex>'.",
    });
  }

  const now = (options.now ?? Date.now)();
  const timestampMs = parsed.timestampSec * 1000;
  const drift = Math.abs(now - timestampMs);
  if (drift > tolerance) {
    // v1.4.0 — renamed from webhook_replay_window_exceeded for
    // alerting clarity. A spike on this code is a replay-attack
    // signal worth a separate dashboard rule from
    // webhook_signature_mismatch (which is a wrong-secret signal).
    throw new CrossdeckError({
      type: "authentication_error",
      code: "webhook_timestamp_outside_tolerance",
      message: `Webhook timestamp is ${drift}ms outside the ${tolerance}ms replay-tolerance window. Either the request is replayed or the receiving clock is skewed — verify NTP on the host.`,
    });
  }

  const signedPayload = `${parsed.timestampSec}.${payload}`;
  const expectedBuf = Buffer.from(parsed.signature, "hex");
  if (expectedBuf.length === 0) {
    throw new CrossdeckError({
      type: "authentication_error",
      code: "webhook_signature_mismatch",
      message: "Webhook signature is not a valid hex string.",
    });
  }

  const anyMatch = secrets.some((s) => {
    const computed = createHmac("sha256", s).update(signedPayload).digest();
    return computed.length === expectedBuf.length && timingSafeEqual(computed, expectedBuf);
  });
  if (!anyMatch) {
    throw new CrossdeckError({
      type: "authentication_error",
      code: "webhook_signature_mismatch",
      message:
        "Webhook signature did not verify against any configured secret. " +
        "Confirm the secret matches your Crossdeck dashboard → Webhooks page (and that you're not on a stale rotation).",
    });
  }

  try {
    return JSON.parse(payload);
  } catch {
    throw new CrossdeckError({
      type: "authentication_error",
      code: "webhook_payload_not_json",
      message:
        "Webhook signature verified but the payload is not valid JSON. Either the payload was tampered with after signing, or the webhook source is misconfigured.",
    });
  }
}

/**
 * Pure-function signing — mirror of what the Crossdeck backend does
 * when sending a webhook. Exported so customers building their own
 * test fixtures (a service that sends Crossdeck-signed webhooks to
 * their own test harness) can re-use the canonical signing scheme
 * instead of re-implementing it.
 *
 *   const ts = Math.floor(Date.now() / 1000);
 *   const sig = signWebhookPayload(payload, secret, ts);
 *   const header = `t=${ts},v1=${sig}`;
 *
 * NOT marked as a security primitive for general HMAC — use
 * `node:crypto` directly for that. This is only the
 * Crossdeck-signature shape.
 */
export function signWebhookPayload(payload: string, secret: string, timestampSec: number): string {
  return createHmac("sha256", secret)
    .update(`${timestampSec}.${payload}`)
    .digest("hex");
}

interface ParsedSignature {
  timestampSec: number;
  signature: string;
}

function parseSignatureHeader(header: string | null): ParsedSignature | null {
  if (!header) return null;
  // Format: "t=<unix>,v1=<hex>". Order-independent, ignore unknown keys.
  let timestampSec: number | null = null;
  let signature: string | null = null;
  for (const part of header.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (key === "t") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) timestampSec = Math.floor(n);
    } else if (key === "v1") {
      if (/^[0-9a-fA-F]+$/.test(value)) signature = value.toLowerCase();
    }
  }
  if (timestampSec === null || signature === null) return null;
  return { timestampSec, signature };
}

function normaliseHeader(input: string | string[] | undefined): string | null {
  if (input === undefined) return null;
  if (Array.isArray(input)) return input[0] ?? null;
  return input;
}

function normaliseSecrets(input: string | string[] | undefined): string[] {
  if (input === undefined || input === null) return [];
  const arr = Array.isArray(input) ? input : [input];
  return arr.filter((s) => typeof s === "string" && s.length > 0);
}
