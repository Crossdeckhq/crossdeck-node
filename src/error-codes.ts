/**
 * Machine-readable index of every error code `@cross-deck/node` can
 * throw, with a short description and a hint on what action to take.
 * Mirrors `@cross-deck/web/src/error-codes.ts`.
 *
 * Stripe publishes the same surface at stripe.com/docs/error-codes;
 * developers love it because every code has a canonical "what does
 * this mean / what should I do" answer.
 *
 * Differences from web:
 *   - Drops browser-only config codes (`invalid_public_key`,
 *     `missing_app_id`, `invalid_environment`, `environment_mismatch`,
 *     `not_initialized`).
 *   - Adds `invalid_secret_key` (Node SDK takes a secret key, not a
 *     publishable key + env declaration).
 *   - Adds Node-lifecycle codes (`flush_on_exit_failed`,
 *     `webhook_invalid_signature`, `webhook_replay_window_exceeded`,
 *     `webhook_missing_secret`).
 *
 * Adding a new error code:
 *   1. Throw it as `CrossdeckError.code` in the call site.
 *   2. Add an entry here so the dashboard + AI assistants can render
 *      the canonical fix.
 *
 * Keep entries terse — consumers surface this in tooltips and
 * automated tickets, not in long-form docs.
 */

export interface ErrorCodeEntry {
  /** The string thrown as `CrossdeckError.code`. */
  code: string;
  /** Broad category — `CrossdeckError.type`. */
  type:
    | "authentication_error"
    | "permission_error"
    | "invalid_request_error"
    | "rate_limit_error"
    | "internal_error"
    | "network_error"
    | "configuration_error";
  /** One-sentence description. Surfaced verbatim in dashboards. */
  description: string;
  /** What the developer should do. Imperative phrasing. */
  resolution: string;
  /** True for codes the SDK can auto-recover from (no developer action). */
  retryable: boolean;
}

/**
 * Internal source-of-truth with literal types preserved via `as const`.
 * The exported `CROSSDECK_ERROR_CODES` widens to `readonly
 * ErrorCodeEntry[]` for the public surface (callers iterating it
 * shouldn't depend on literal positions), while `CrossdeckErrorCode`
 * below derives the literal union from this constant for type-safe
 * code narrowing.
 */
const _CROSSDECK_ERROR_CODES = Object.freeze([
  // ----- Configuration -----
  {
    code: "invalid_secret_key",
    type: "configuration_error",
    description: "The secret key passed to new CrossdeckServer({ secretKey }) doesn't start with cd_sk_.",
    resolution: "Copy the key from your Crossdeck dashboard → API keys page. Server SDKs use cd_sk_test_… (sandbox) or cd_sk_live_… (production). Never ship this key to a browser.",
    retryable: false,
  },

  // ----- Argument validation -----
  {
    code: "missing_user_id",
    type: "invalid_request_error",
    description: "identify() / aliasIdentity() called with an empty userId.",
    resolution: "Pass a stable, non-empty user identifier from your auth layer — never a hardcoded placeholder.",
    retryable: false,
  },
  {
    code: "missing_anonymous_id",
    type: "invalid_request_error",
    description: "aliasIdentity() called with an empty anonymousId.",
    resolution: "Pass the anonymousId originally minted by the web SDK on this user's device.",
    retryable: false,
  },
  {
    code: "missing_customer_id",
    type: "invalid_request_error",
    description: "An operation that requires a Crossdeck customer ID was called with an empty value.",
    resolution: "Pass the customerId returned from a prior identify() / getEntitlements() call.",
    retryable: false,
  },
  {
    code: "missing_identity",
    type: "invalid_request_error",
    description: "An ingest / forget / entitlements call received no identity hints.",
    resolution: "Pass at least one of customerId, userId, or anonymousId on the call (or per-event for ingest).",
    retryable: false,
  },
  {
    code: "missing_event_name",
    type: "invalid_request_error",
    description: "track() / ingest() received an event without a name.",
    resolution: "Pass a non-empty string as the event name. The wire shape is { name, properties? }.",
    retryable: false,
  },
  {
    code: "missing_events",
    type: "invalid_request_error",
    description: "ingest() received an empty array.",
    resolution: "Pass at least one event. Use server.track(event) to send a single event.",
    retryable: false,
  },
  {
    code: "missing_event_id",
    type: "invalid_request_error",
    description: "getAuditEntry() called with an empty eventId.",
    resolution: "Pass the eventId from the audit row you want to inspect.",
    retryable: false,
  },
  {
    code: "missing_signed_transaction_info",
    type: "invalid_request_error",
    description: "syncPurchases() called without StoreKit 2 signed transaction info.",
    resolution: "Pass the JWS string from Transaction.currentEntitlements / Transaction.updates.",
    retryable: false,
  },
  {
    code: "missing_group_type",
    type: "invalid_request_error",
    description: "group(type, id) called with an empty type.",
    resolution: "Pass a non-empty group type (e.g. \"org\", \"team\", \"plan\") as the first argument.",
    retryable: false,
  },
  {
    code: "serialization_failed",
    type: "invalid_request_error",
    description: "An event payload or trait bag could not be JSON-serialised even after sanitisation.",
    resolution: "Inspect the payload for non-JSON-friendly values (functions, symbols, deeply circular refs). The SDK's validator drops these by default, so this usually means a bug — file an issue with the payload shape.",
    retryable: false,
  },

  // ----- Network / transport -----
  {
    code: "fetch_failed",
    type: "network_error",
    description: "The underlying fetch() call failed (typically a network outage, DNS, or refused connection).",
    resolution: "Check the host's outbound network. The SDK retries automatically with exponential backoff + jitter for queued events.",
    retryable: true,
  },
  {
    code: "request_timeout",
    type: "network_error",
    description: "A request was aborted after the configured timeoutMs (default 15s).",
    resolution: "Check the host's network. Increase timeoutMs in CrossdeckServer options if you're on a known-slow link.",
    retryable: true,
  },
  {
    code: "invalid_json_response",
    type: "internal_error",
    description: "The server returned a 2xx with an unparseable body.",
    resolution: "Likely a transient backend bug. Retry; if it persists, contact support with the requestId.",
    retryable: true,
  },

  // ----- Lifecycle (Node-specific) -----
  {
    code: "flush_on_exit_failed",
    type: "internal_error",
    description: "The on-exit drain (beforeExit / SIGTERM / SIGINT) did not complete before flushOnExitTimeoutMs.",
    resolution: "Increase flushOnExitTimeoutMs in CrossdeckServer options. Default is 2000ms; serverless runtimes typically allow 5-10s before SIGKILL. If events are dropping silently in production, raise this.",
    retryable: false,
  },

  // ----- Webhook verification (Node-specific) -----
  {
    code: "webhook_invalid_signature",
    type: "authentication_error",
    description: "The webhook signature header did not verify against the supplied secret.",
    resolution: "Confirm the secret matches the one in your Crossdeck dashboard → Webhooks page. If the request is genuinely from Crossdeck, the secret is wrong, stale, or recently rotated.",
    retryable: false,
  },
  {
    code: "webhook_replay_window_exceeded",
    type: "authentication_error",
    description: "The webhook timestamp is older than the replay-tolerance window (default 5 minutes).",
    resolution: "The webhook is either replayed or your receiving clock is wildly skewed. Verify NTP on the receiving host. Increase replayToleranceMs only if you accept the replay-attack risk.",
    retryable: false,
  },
  {
    code: "webhook_missing_secret",
    type: "configuration_error",
    description: "verifyWebhookSignature() was called without a signing secret.",
    resolution: "Pass the secret from your Crossdeck dashboard → Webhooks page. Never hardcode in source — read from an env var.",
    retryable: false,
  },
] as const);

/**
 * Literal union of every code documented in `CROSSDECK_ERROR_CODES`.
 * Exported so callers can do type-safe code comparisons:
 *
 *   if (err.code === "webhook_invalid_signature") { ... }    // typed
 *   if (err.code === "webook_invalid_signature") { ... }     // TS error
 *
 * Mis-spelling a code at compile time fails to compile — the gap that
 * silently broke v0.1.0 callers checking for non-existent codes.
 */
export type CrossdeckErrorCode = (typeof _CROSSDECK_ERROR_CODES)[number]["code"];

/** Type guard: narrows a string to the documented literal union. */
export function isCrossdeckErrorCode(code: string): code is CrossdeckErrorCode {
  return _CROSSDECK_ERROR_CODES.some((e) => e.code === code);
}

/**
 * Public catalogue, widened to `readonly ErrorCodeEntry[]` for iteration
 * stability. Callers needing literal types should reach for the
 * `CrossdeckErrorCode` union above instead of indexing into this array.
 */
export const CROSSDECK_ERROR_CODES: readonly ErrorCodeEntry[] = _CROSSDECK_ERROR_CODES;

/** Lookup helper — returns the entry matching a CrossdeckError.code, or undefined. */
export function getErrorCode(code: string): ErrorCodeEntry | undefined {
  return CROSSDECK_ERROR_CODES.find((e) => e.code === code);
}
