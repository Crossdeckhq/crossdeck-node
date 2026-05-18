# Changelog

All notable changes to `@cross-deck/node` will be documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-05-18

### Added

- **Pluggable durable entitlement store (`entitlementStore`).** A new
  constructor option taking an async `EntitlementStore` (a `load` /
  `save` pair) — back it with Redis, your own database, or a KV. Every
  successful `getEntitlements()` persists the result to it, and on a
  network failure the SDK falls back to the stored snapshot. This is
  what gives serverless deployments (Cloud Run / Lambda) cold-start
  durability that an in-memory cache alone cannot. `EntitlementStore`
  and `StoredEntitlements` are exported.
- **Staleness fields in `diagnostics()`.** `entitlements.staleCustomers`,
  `isStale`, `durableStore`, and `coldStartDurable` — so serving
  last-known-good through a Crossdeck outage is observable, not silent.
- **`sdk.no_durable_store` debug signal**, emitted once on a serverless
  runtime with no `entitlementStore` configured, alongside a
  `durability` fact on the boot telemetry event — so the cold-start gap
  is measurable rather than a surprise in production.

### Changed

- **The entitlement cache is now durable last-known-good.**
  `isEntitled()` and `list()` no longer expire to `false` / `[]` when
  `entitlementCacheTtlMs` elapses — they keep serving the last
  successfully-fetched entitlements. The TTL is now a refresh hint, not
  an invalidation. Each entitlement is still honoured against its own
  `validUntil`. A brief Crossdeck outage can no longer fail a paying
  customer down to free 60 seconds after a warm.

## [1.1.1] — 2026-05-14

### Changed

- Ported the "never silently surface an `Unknown` error" hardening to
  `@cross-deck/node` — a captured error with no usable type or message
  is now labelled precisely instead of collapsing to `Unknown error`.

## [1.1.0] — 2026-05-13

### Added

- **Auto-heartbeat on construction.** `new CrossdeckServer({...})` now
  fires a heartbeat in the background the moment the SDK is
  constructed, fire-and-forget. The dashboard's row flips LIVE within
  ~200 ms of the customer's process boot — no explicit `.heartbeat()`
  call required in the bootstrap. Solves the cold-start serverless
  verification problem at its root (function boot triggers SDK
  construction triggers heartbeat; the install-verifier's URL probe
  doubles as a cold-start waker).
- New option `bootHeartbeat?: boolean` (default `true`). Set `false`
  for latency-sensitive cold paths that want the prior v1.0.0
  caller-controlled behaviour. Implicitly disabled in `testMode`.

### Why this is non-breaking

The boot heartbeat is fire-and-forget and swallows its own errors —
the caller's code never blocks on it, never throws, and a failure
(bad key, network blip, firewall) has zero effect on subsequent
event flushes. Equivalent to Sentry's `Sentry.init()` boot session.

## [1.0.0] — 2026-05-13

Full three-USP server SDK release. Version-aligned with `@cross-deck/web@1.0.0`. Bank-grade quality bar — Stripe + Apple + Google VP-level QA review across two passes. 6,796 LOC of source / 6,230 LOC of tests / 398 unit tests + 19 e2e todos passing / Gate 3 fixture verifying the snippet against the built bundle. Web-SDK parity at the capability level: every Web SDK guarantee that has a server-side analogue ships here.

### Added — USP 1 (errors)

- `server.captureError(err, options?)` — manual try/catch capture.
- `server.captureMessage(msg, level?)` — non-error signals (Sentry pattern).
- `server.setTag(key, value)` / `setTags(tags)` / `setContext(name, data)` / `addBreadcrumb(crumb)` / `setErrorBeforeSend(hook)`.
- Auto-wired `process.on('uncaughtException')` + `process.on('unhandledRejection')` + `globalThis.fetch` wrap (5xx + network failures).
- Stack-frame parsing (V8 + Firefox/Safari) with Node `in_app` heuristics for `node_modules/`, `node:`, `internal/`, `@cross-deck/node`.
- Breadcrumb ring buffer (default 50 entries) attached to every error report.
- djb2-fingerprinted grouping + per-fingerprint rate limit (default 5/min) + per-session cap (default 100). Fingerprint Map bounded at 4,096 with dead-entry prune + FIFO eviction.

### Added — USP 2 (analytics)

- Durable event queue: exponential backoff with full jitter, `Retry-After` honoured, **`Idempotency-Key` reused on retry of the same batch** (Stripe pattern).
- `flush-on-exit` — `process.on('beforeExit')` + SIGTERM + SIGINT drain bounded by `flushOnExitTimeoutMs`. Critical for Lambda / Cloud Functions where the runtime freezes between invocations.
- `server.register(properties)` / `server.unregister(key)` / `server.group(type, id, traits?)` — Mixpanel-style super-properties + group analytics.
- `@cross-deck/node/auto-events` subpath:
  - `crossdeckExpress(server, opts?)` + `crossdeckExpressErrorHandler(server, opts?)` (Express 4 + 5) — emits `request.handled` with route + method + statusCode + durationMs + userAgent + responseBytes. Captures uncaught route errors with request context.
  - `wrapLambdaHandler(server, handler, opts?)` — emits `function.invoked` / `function.completed` / `function.failed` with cold-start detection, awaits `flush()` before return. Extracts `statusCode` + `responseBytes` for HTTP-style returns.
  - `wrapFunction(server, handler, opts?)` — generic Firebase v1/v2 / Cloud Run wrap, shape-preserving.

### Added — USP 3 (entitlements)

- Per-customer TTL cache (default 60s) with **LRU eviction bounded at `maxCustomers` (default 10,000)** for long-running multi-tenant servers.
- `server.isEntitled(hint, key)` — synchronous lookup after first warm. Accepts canonical `customerId` OR `IdentityHints` ({customerId, userId, anonymousId}).
- `server.listEntitlements(hint)` — full snapshot.
- `server.onEntitlementsChange(listener)` — subscribe to cache mutations.
- `userId` / `anonymousId` → `crossdeckCustomerId` alias map (bounded at 10,000 with FIFO eviction).
- `verifyWebhookSignature(payload, header, secret, options?)` — HMAC-SHA256 + constant-time compare + 5-min replay window + multi-secret rotation.
- `signWebhookPayload(payload, secret, timestampSec)` — pure helper for fixture authors.

### Added — cross-cutting

- `runtime-info` detection for 13 platforms: AWS Lambda, Azure Functions, Google App Engine, Firebase Functions v1/v2, Cloud Run, Vercel, Netlify, Heroku, Render, Railway, Fly.io, generic Kubernetes, plain Node fallback. Auto-attached as `runtime.*` on every event + error.
- `server.heartbeat()` — boot validation: `GET /sdk/heartbeat` returns project + app metadata, throws on auth failure.
- `server.flush(): Promise<void>` — explicit drain.
- `server.diagnostics()` — stable shape with `runtime` + `events` + `errors` + `entitlements` blocks.
- `server.shutdown()` — teardown for tests + custom lifecycles. Clears super-properties, groups, cache, aliases, breadcrumbs, error state.
- `scrubPii(value)` + `scrubPiiFromProperties(obj)` — opt-in PII regex utilities (email + card-number shapes).
- `ConsoleDebugLogger` + `NullDebugLogger` — NorthStar §16 debug signal vocabulary.
- `CrossdeckErrorCode` literal union derived from `CROSSDECK_ERROR_CODES` + `isCrossdeckErrorCode()` type guard for type-safe code comparisons.
- `HeartbeatResponse` + `Diagnostics` + 30+ exported types.
- `/auto-events` subpath in `package.json` exports.

### Changed

- **Breaking**: `track(event)` is now synchronous (returns `void`), enqueues for batched delivery, and auto-fills `anonymousId` with a process-stable `anon_node_…` when no identity hint is supplied. The old `await track(...)` shape is replaced by enqueue-and-flush.
- `ingest(events[])` retains immediate-POST behaviour for bulk-import callers (no auto-fill, returns `IngestResponse`).
- Secret key prefix in `diagnostics()` is now masked as `cd_sk_(test|live)_****<last4>` (Stripe pattern).

### Added — QA review v2 (bank-grade SDK extras)

- **Error subclass hierarchy** (Stripe pattern):
  `CrossdeckAuthenticationError`, `CrossdeckPermissionError`,
  `CrossdeckValidationError`, `CrossdeckRateLimitError`,
  `CrossdeckNetworkError`, `CrossdeckInternalError`,
  `CrossdeckConfigurationError`. All extend `CrossdeckError`. Pick the
  right subclass via `makeCrossdeckError(payload)`. Constructed
  automatically by `crossdeckErrorFromResponse()`.
- `CrossdeckError.toJSON()` — structured-logger compatible
  serialisation. Includes `type`, `code`, `requestId`, `status`,
  `retryAfterMs`, `stack`. Critical for production observability with
  Pino / Winston / DataDog.
- `Crossdeck-Api-Version` header on every request, pinned to
  `CROSSDECK_API_VERSION` constant. Forward-compat with backend
  evolution (Stripe `Stripe-Version` pattern).
- `User-Agent` header: `@cross-deck/node/<sdk> node/<node-version> <platform>`.
  HTTP best practice. Override the runtime token via
  `runtimeToken: "bun/1.0"` in options.
- **Idempotent retry on GET methods** — default 3 attempts with
  exponential backoff + full jitter, retrying on 408 + 5xx (except
  501) and on network failures. Honours server `Retry-After`. POST
  retries stay queue-driven (with batch-level `Idempotency-Key` reuse).
  Configurable via `httpRetries: { maxAttempts, retryableStatuses }`.
- `testMode: true` option — every HTTP call short-circuits to a
  synthetic success response, no network goes out. Path-aware (returns
  the right shape per endpoint). For caller test suites that don't
  want to mock `globalThis.fetch`.
- `onRequest` / `onResponse` hooks on `CrossdeckServerOptions`. Fire
  on every request (including retries), carrying method, URL, status,
  durationMs, attempt number. Synchronous, errors swallowed — telemetry
  must never break the request pipeline.
- **AbortSignal pass-through** on every async method. Final
  `RequestOptions` argument with `{ signal, timeoutMs }`. Caller-aborted
  requests throw `CrossdeckNetworkError({ code: "request_aborted" })`.
  Composes with the per-request timeout — whichever fires first wins.
- **CrossdeckServer extends EventEmitter** — typed `on` / `once` /
  `off` / `emit` overloads via `CrossdeckServerEvents`. Events:
  `queue.flush_succeeded`, `queue.flush_failed`, `queue.dropped`,
  `queue.buffer_changed`, `error.captured`, `entitlements.warmed`,
  `sdk.shutdown`.
- **`Symbol.dispose` + `Symbol.asyncDispose`** — TC39 explicit
  resource management. `using server = new CrossdeckServer(...)`
  shuts down on scope exit; `await using` flushes first.
- `server.isReady(): boolean` — synchronous readiness check.
  `false` on sustained retry storm (≥ 5 consecutive failures) or
  buffer pressure (≥ 80% of HARD_BUFFER_CAP).
- `server.awaitReady(timeoutMs?, pollIntervalMs?): Promise<boolean>` —
  backpressure-aware wait for ready state.
- `server.getHealth()` — k8s-friendly snapshot: `ready`, `healthy`,
  `bufferedEvents`, `inFlight`, `consecutiveFailures`, `lastFlushAt`,
  `lastError`, `errorHandlersInstalled`.
- `server.bulkGrantEntitlement(grants[])` + `bulkRevokeEntitlement(revokes[])` —
  bounded-concurrency fan-out (default 5). Returns settled array;
  partial failures preserved as `{ ok: false, error }` entries.

### Notes

- Bundle size: `dist/index.cjs` ~98 KB, `dist/auto-events/index.cjs` ~11 KB.
- Zero runtime dependencies (`fetch` + `node:crypto` + `node:events` only).
- 398 unit tests + 19 e2e todos passing. Source-to-test ratio ~100%.
- Deferred to later releases: Fastify adapter (v0.3.0), Cloudflare Workers / Vercel Edge / Bun / Deno (v0.4+), OpenTelemetry / Pino / Winston log-capture integration (roadmap), HTTP keep-alive agent, request compression, SDK-level sampling.

## [0.1.0] — 2026-05-12

Initial server SDK release.

### Added

- Separate `@cross-deck/node` package with no browser assumptions.
- `CrossdeckServer` constructor with secret-key validation.
- Secret-key HTTP transport with typed `CrossdeckError` handling.
- Web-parity sanitisation for traits and event properties, plus a transport
  backstop that converts serialization failures into stable `CrossdeckError`s.
- `identify()` / `aliasIdentity()` for server-side identity linking.
- `forget()` for server-side GDPR/CCPA deletion requests.
- `getEntitlements()` by `customerId`, `userId`, or `anonymousId`.
- `getCustomerEntitlements(customerId)` server-only direct lookup route.
- `track()` and `ingest()` for explicit server-side event ingest.
- `syncPurchases()` for Apple signed purchase forwarding.
- `grantEntitlement()` and `revokeEntitlement()` server-side manual overrides.
- `getAuditEntry()` for server-side audit-log reads.
- Dual ESM/CJS build.
- Strict TypeScript + Vitest coverage for transport and public method routing.
