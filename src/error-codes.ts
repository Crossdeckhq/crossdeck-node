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
    | "version_error"
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
  // v1.4.0 Phase 7.2 — distinguishable codes. Pre-v1.4.0 the
  // helper used webhook_invalid_signature for nearly every failure
  // mode so a customer couldn't separate replay-attack signals
  // from wrong-secret signals in alerting.
  {
    code: "webhook_signature_mismatch",
    type: "authentication_error",
    description: "Webhook HMAC didn't verify against any configured secret (wrong-secret / stale rotation signal).",
    resolution: "Confirm the secret matches dashboard → Webhooks. If you rotated, include both the old and new secret as an array until receivers cut over.",
    retryable: false,
  },
  {
    code: "webhook_timestamp_outside_tolerance",
    type: "authentication_error",
    description: "Webhook timestamp drift exceeds the configured replay-tolerance window (default 5 minutes; replay-attack signal).",
    resolution: "Verify NTP on the receiving host. A spike on this code warrants its own alert separate from signature_mismatch — replay attacks look like this.",
    retryable: false,
  },
  {
    code: "webhook_timestamp_missing",
    type: "authentication_error",
    description: "Webhook signature header is absent or has no `t=` timestamp segment — the timestamp gate cannot be verified.",
    resolution: "Confirm the request actually came from Crossdeck (signature headers are always present on real deliveries). A missing header is either a misconfigured intermediary or a forged request.",
    retryable: false,
  },
  {
    code: "webhook_payload_not_json",
    type: "authentication_error",
    description: "Webhook signature verified but the body isn't valid JSON — payload tampered post-signing or source bug.",
    resolution: "Inspect the raw payload. If it's not JSON, either the request was modified in transit or the sender has a bug — file a support ticket with the raw body.",
    retryable: false,
  },
  {
    code: "webhook_invalid_tolerance",
    type: "configuration_error",
    description: "verifyWebhookSignature() called with a non-finite / negative / above-24h-cap replayToleranceMs (would silently disable replay protection).",
    resolution: "Pass a finite number between 0 and 86_400_000ms (24h). Default (5 minutes) is correct for almost every scenario. Pre-v1.4.0 accepted Infinity/NaN and silently dropped the check.",
    retryable: false,
  },
  {
    code: "webhook_missing_secret",
    type: "configuration_error",
    description: "verifyWebhookSignature() was called without a signing secret.",
    resolution: "Pass the secret from your Crossdeck dashboard → Webhooks page. Never hardcode in source — read from an env var.",
    retryable: false,
  },
  {
    code: "webhook_invalid_signature",
    type: "authentication_error",
    description: "DEPRECATED in v1.4.0 — split into webhook_signature_mismatch / webhook_timestamp_missing / webhook_timestamp_outside_tolerance / webhook_payload_not_json for alerting clarity.",
    resolution: "Migrate alert rules to the more specific v1.4.0 codes — they distinguish replay-attack signals from wrong-secret signals.",
    retryable: false,
  },
  {
    code: "webhook_replay_window_exceeded",
    type: "authentication_error",
    description: "DEPRECATED in v1.4.0 — renamed to webhook_timestamp_outside_tolerance.",
    resolution: "Update alerts to webhook_timestamp_outside_tolerance.",
    retryable: false,
  },

  // ----- Backend-emitted codes (v1.4.0 Phase 6.2 backfill) -----
  // Mirror of backend/src/api/v1-errors.ts ApiErrorCode. Same set
  // as the Web SDK ships — keep these synchronised so a developer
  // hitting any code via either SDK gets the same remediation.
  {
    code: "missing_api_key",
    type: "authentication_error",
    description: "No Authorization header (or Crossdeck-Api-Key header) on the request.",
    resolution: "Confirm the CrossdeckServer was constructed with a cd_sk_… secretKey. Re-check env vars in production deployments.",
    retryable: false,
  },
  {
    code: "invalid_api_key",
    type: "authentication_error",
    description: "The secret key is malformed, unknown, or doesn't resolve to a project.",
    resolution: "Copy the key from Crossdeck dashboard → API keys. Server SDK requires cd_sk_test_ / cd_sk_live_ — client SDK keys (cd_pub_…) won't work on the Node SDK.",
    retryable: false,
  },
  {
    code: "key_revoked",
    type: "authentication_error",
    description: "The secret key was revoked in the dashboard.",
    resolution: "Mint a fresh key in dashboard → API keys → Create new. The revoked key cannot be reactivated.",
    retryable: false,
  },
  {
    code: "env_mismatch",
    type: "permission_error",
    description: "The key's env prefix doesn't match the resolved app's configured env.",
    resolution: "Use a cd_sk_live_ key with a production app, cd_sk_test_ with a sandbox app. Crossing breaks the env lock.",
    retryable: false,
  },
  {
    code: "idempotency_key_in_use",
    type: "invalid_request_error",
    description: "An Idempotency-Key was reused for a request with a different body (Stripe-grade contract).",
    resolution: "Server SDK derives keys deterministically from the body since v1.4.0; this should only fire if you passed options.idempotencyKey explicitly. Use a fresh key per logical operation.",
    retryable: false,
  },
  {
    code: "rate_limited",
    type: "rate_limit_error",
    description: "Request rate exceeded the project's per-second cap.",
    resolution: "Honour Retry-After (managed retries do this automatically). For custom paths, throttle to <100 req/s/key.",
    retryable: true,
  },
  {
    code: "internal_error",
    type: "internal_error",
    description: "Server-side issue. Safe to retry with backoff.",
    resolution: "Managed retries handle this automatically. If a code path surfaces it to your code, contact support with the requestId.",
    retryable: true,
  },
  {
    code: "google_not_supported",
    type: "invalid_request_error",
    description: "POST /purchases/sync with rail=google is gated until the Play Developer API reconciliation worker ships.",
    resolution: "Until v1.5+, Google Play purchases verify via Real-time Developer Notifications. The Android SDK auto-track path handles this transparently.",
    retryable: false,
  },
  {
    code: "stripe_not_supported",
    type: "invalid_request_error",
    description: "POST /purchases/sync with rail=stripe is unsupported — Stripe webhooks deliver evidence server-side.",
    resolution: "Wire Stripe via the standard Checkout / Customer Portal flow; Crossdeck reconciles via the platform webhook automatically.",
    retryable: false,
  },
  {
    code: "missing_required_param",
    type: "invalid_request_error",
    description: "A required field is absent from the request body.",
    resolution: "The error.message identifies the missing field. Refer to the SDK's TypeScript types for canonical shapes.",
    retryable: false,
  },
  {
    code: "invalid_param_value",
    type: "invalid_request_error",
    description: "A field is present but the value failed validation.",
    resolution: "Read error.message for the field + reason. SDK-managed call sites should never emit this — file a bug if you do.",
    retryable: false,
  },
  {
    code: "sdk_version_unsupported",
    type: "version_error",
    description: "HTTP 426 — your installed SDK sends an event format the server no longer accepts. The data is good; only the wire dialect is too old. The SDK PARKS automatically: events are held in memory and deliver once you upgrade and restart.",
    resolution: "Update @cross-deck/node to at least the version in error.minVersion and restart — the held queue backfills. See https://cross-deck.com/docs/sdk-event-durability/.",
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
