/**
 * PII scrub utilities — Node port of `@cross-deck/web/src/consent.ts`'s
 * regex-based defence layer.
 *
 * **What's NOT here (intentionally)**: the `ConsentManager` class. That's
 * a browser/end-user UX surface (DNT detection, per-dimension consent
 * gating). On the server side, the customer's user already accepted
 * or declined consent in their client; the API caller decides what
 * to forward. Shipping `ConsentManager` here would imply server-side
 * gating that doesn't match the trust model.
 *
 * **What IS here**: opt-in utilities customers can use to scrub
 * email-shaped and card-number-shaped substrings out of event
 * properties before forwarding to Crossdeck. Stripe-grade defence in
 * depth, applied at the caller's discretion:
 *
 *   import { scrubPiiFromProperties } from "@cross-deck/node";
 *
 *   server.track({
 *     name: "checkout.started",
 *     developerUserId: userId,
 *     properties: scrubPiiFromProperties({
 *       url: req.url, // might contain "/users/wes@…/" — gets [email]
 *       lastError: e.message, // might contain card numbers
 *     }),
 *   });
 */

/**
 * Email-shaped pattern. Restrictive enough to match the practical
 * 99% of emails (RFC 5322's "obs-local-part" common case) without
 * false positives. We deliberately don't try to match every legal
 * email; the goal is "if it looks like an email, scrub it."
 */
const EMAIL_PATTERN =
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Card-number-shaped pattern. Matches sequences of 13-19 digits that
 * could be split by space or hyphen — the format every payment form
 * accepts. We don't validate Luhn; this is best-effort scrubbing,
 * not card-data tokenisation. If you're handling actual PAN data you
 * should not be passing it through analytics in the first place.
 *
 * Anchored on a digit at both ends so trailing separators (space /
 * hyphen) aren't pulled into the match — otherwise
 * "4242 4242 4242 4242 today" would scrub as "[card]today" instead of
 * "[card] today".
 */
const CARD_PATTERN = /\b\d(?:[ -]?\d){12,18}\b/g;

const REPLACEMENT_EMAIL = "[email]";
const REPLACEMENT_CARD = "[card]";

/**
 * Scrub a single string value: replace email-shaped substrings with
 * `[email]` and card-number-shaped substrings with `[card]`. Returns
 * the original string (===) when nothing matched, so callers can do
 * an identity-check to skip allocating a new event copy.
 */
export function scrubPii(value: string): string {
  if (!value) return value;
  let out = value;
  if (EMAIL_PATTERN.test(out)) {
    out = out.replace(EMAIL_PATTERN, REPLACEMENT_EMAIL);
  }
  // Reset regex lastIndex (global flag carries state between calls).
  EMAIL_PATTERN.lastIndex = 0;
  if (CARD_PATTERN.test(out)) {
    out = out.replace(CARD_PATTERN, REPLACEMENT_CARD);
  }
  CARD_PATTERN.lastIndex = 0;
  return out;
}

/**
 * Walk a property bag and replace PII-shaped strings in place. Returns
 * a new object with strings scrubbed; non-string values pass through
 * unchanged.
 *
 * Defensive copy — the input is never altered. Caller can pass the
 * result straight to `server.track()`.
 *
 * Recursive: nested objects + arrays are walked. Functions, symbols,
 * Dates, etc. pass through untouched (those are the
 * `validateEventProperties` sanitiser's job — this is just the
 * PII regex pass).
 */
export function scrubPiiFromProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(properties)) {
    out[k] = scrubValue(properties[k]);
  }
  return out;
}

function scrubValue(v: unknown): unknown {
  if (typeof v === "string") return scrubPii(v);
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === "object" && v.constructor === Object) {
    // Plain objects only — Date, Map, Set, Error are left untouched
    // (the property validator already handles those). This avoids
    // accidentally mutating an Error's `message` and confusing the
    // downstream error reporting layer.
    return scrubPiiFromProperties(v as Record<string, unknown>);
  }
  return v;
}
