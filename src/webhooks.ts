/**
 * Webhook signature verification — Stripe pattern.
 *
 * Lets customers verify the events Crossdeck sends to THEM. Table-stakes
 * for any backend SDK (Stripe ships `Stripe.webhooks.constructEvent()`
 * from day one, Svix ships `Webhook.verify()` from day one).
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
   * 5 minutes (5 * 60 * 1000). Anything older than this is rejected
   * as a replay. Pass 0 to disable the replay window (NOT recommended
   * — accept the trade-off only if you have a separate replay defence).
   */
  replayToleranceMs?: number;
  /**
   * Override the current time. Tests use this to verify timestamp
   * handling deterministically. Defaults to `Date.now()`.
   */
  now?: () => number;
}

const DEFAULT_REPLAY_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Verify a Crossdeck-signed webhook. Returns the parsed JSON payload
 * on success. Throws `CrossdeckError` on:
 *   - missing / malformed signature header (`webhook_invalid_signature`)
 *   - missing secret (`webhook_missing_secret`)
 *   - timestamp outside replay window (`webhook_replay_window_exceeded`)
 *   - HMAC mismatch (`webhook_invalid_signature`)
 *   - non-JSON payload (`webhook_invalid_signature` — same code because
 *     a tampered payload that breaks JSON parses as invalid)
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

  const header = normaliseHeader(signatureHeader);
  const parsed = parseSignatureHeader(header);
  if (!parsed) {
    throw new CrossdeckError({
      type: "authentication_error",
      code: "webhook_invalid_signature",
      message:
        "Webhook signature header is missing or malformed. Expected 'Crossdeck-Signature: t=<unix>,v1=<hex>'.",
    });
  }

  const tolerance = options.replayToleranceMs ?? DEFAULT_REPLAY_TOLERANCE_MS;
  if (tolerance > 0) {
    const now = (options.now ?? Date.now)();
    const timestampMs = parsed.timestampSec * 1000;
    const drift = Math.abs(now - timestampMs);
    if (drift > tolerance) {
      throw new CrossdeckError({
        type: "authentication_error",
        code: "webhook_replay_window_exceeded",
        message: `Webhook timestamp is ${drift}ms outside the ${tolerance}ms replay-tolerance window. Either the request is replayed or the receiving clock is skewed — verify NTP on the host.`,
      });
    }
  }

  const signedPayload = `${parsed.timestampSec}.${payload}`;
  const expectedBuf = Buffer.from(parsed.signature, "hex");
  if (expectedBuf.length === 0) {
    throw new CrossdeckError({
      type: "authentication_error",
      code: "webhook_invalid_signature",
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
      code: "webhook_invalid_signature",
      message:
        "Webhook signature did not verify. Confirm the secret matches your Crossdeck dashboard → Webhooks page (and that you're not on a stale rotation).",
    });
  }

  try {
    return JSON.parse(payload);
  } catch {
    throw new CrossdeckError({
      type: "authentication_error",
      code: "webhook_invalid_signature",
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
