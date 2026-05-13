/**
 * @cross-deck/node — `CrossdeckServer`, the orchestrator.
 *
 * v1.0.0 expands beyond the v0.1.0 thin HTTP client to ship the three
 * Crossdeck USPs on the server:
 *
 *   1. Errors — `captureError`, `captureMessage`, auto-wired
 *      `process.on('uncaughtException')` + `process.on('unhandledRejection')`,
 *      `globalThis.fetch` wrap, stack-frame parsing, breadcrumb
 *      attachment, fingerprint dedup, rate-limit per fingerprint.
 *      [USP 1 — landed v1.0.0]
 *
 *   2. Analytics — `track()` switches from sync-HTTP-per-event to
 *      enqueue-and-batch via `EventQueue` (durable, retried, idempotent
 *      per batch). `flush-on-exit` drains before Cloud Function / Lambda
 *      teardown so events don't vanish silently.
 *      [USP 1 ships queue + flush-on-exit; super-props + auto-events
 *       arrive in USP 2]
 *
 *   3. Entitlements — TTL-cached `isEntitled()` so hot-path gates are
 *      memory reads after first warm.
 *      [USP 3 — pending]
 *
 * Cross-cutting: every event + error carries `runtime.*` enrichment
 * (Node version, OS, host, region, function name, instance ID) auto-
 * attached via `collectRuntimeInfo()`.
 *
 * The non-event endpoints (identify / aliasIdentity / forget /
 * getEntitlements / getCustomerEntitlements / syncPurchases /
 * grantEntitlement / revokeEntitlement / getAuditEntry) stay as direct
 * HTTP — they're transactional, not telemetry. Only `track()` changed
 * to queue-based.
 */

import { EventEmitter } from "node:events";

import { CrossdeckError } from "./errors";
import { validateEventProperties } from "./event-validation";
import {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  HttpClient,
  SDK_NAME,
  SDK_VERSION,
} from "./http";
import { EventQueue, type BatchEnvelope, type QueuedEvent } from "./event-queue";
import { BreadcrumbBuffer, type Breadcrumb, type BreadcrumbCategory } from "./breadcrumbs";
import {
  DEFAULT_ERROR_CAPTURE,
  ErrorTracker,
  type CapturedError,
  type ErrorCaptureConfig,
} from "./error-capture";
import { collectRuntimeInfo, runtimeInfoToProperties, type RuntimeInfo } from "./runtime-info";
import { FlushOnExit } from "./flush-on-exit";
import { SuperPropertyStore, type GroupMembership } from "./super-properties";
import { EntitlementCache, type EntitlementsListener } from "./entitlement-cache";
import { ConsoleDebugLogger, NullDebugLogger, findSensitivePropertyKeys, type DebugLogger } from "./debug";
import { mintId } from "./_rand";
import type {
  AliasIdentityInput,
  AliasResult,
  AuditEntry,
  AuditEntryResponse,
  CrossdeckServerOptions,
  Diagnostics,
  EntitlementMutationResult,
  EntitlementsListResponse,
  Environment,
  ErrorLevel,
  EventProperties,
  ForgetResult,
  GrantEntitlementInput,
  HeartbeatResponse,
  IdentityHints,
  IdentifyOptions,
  IngestOptions,
  IngestResponse,
  PublicEntitlement,
  PurchaseResult,
  RequestOptions,
  RevokeEntitlementInput,
  ServerEvent,
  SyncPurchaseInput,
} from "./types";

/**
 * Typed event names + payloads emitted by `CrossdeckServer`. Caller
 * subscribes via the standard EventEmitter API:
 *
 *   server.on("queue.flush_failed", ({ error, attempt }) => { ... });
 *   server.once("sdk.shutdown", () => { ... });
 *
 * The typed `on` / `off` / `emit` overloads narrow the listener
 * arguments to the right shape. Untyped event names still work for
 * forward compat with any backend-side additions.
 */
export interface CrossdeckServerEvents {
  /** Fired once per batch on successful flush. */
  "queue.flush_succeeded": [info: { batchSize: number; durationMs: number }];
  /** Fired on every failed flush attempt. */
  "queue.flush_failed": [info: { error: CrossdeckError | string; attempt: number; nextRetryMs: number }];
  /** Fired when the queue drops oldest events due to HARD_BUFFER_CAP. */
  "queue.dropped": [info: { count: number }];
  /** Fired when the buffer changes size — used by callers wanting backpressure-aware tracking. */
  "queue.buffer_changed": [info: { size: number }];
  /** Fired when an error is captured (manual or auto). */
  "error.captured": [info: { fingerprint: string; kind: string; message: string }];
  /** Fired once after `getEntitlements()` warms the cache for a customer. */
  "entitlements.warmed": [info: { customerId: string; count: number }];
  /** Fired on `shutdown()` / `[Symbol.dispose]` / `[Symbol.asyncDispose]`. */
  "sdk.shutdown": [info: { reason: "shutdown" | "dispose" | "asyncDispose" }];
}

export class CrossdeckServer extends EventEmitter {
  private readonly http: HttpClient;
  private readonly sdkVersion: string;
  private readonly baseUrl: string;
  private readonly appId: string | undefined;
  private readonly env: Environment;
  private readonly secretKeyPrefix: string;

  /**
   * Process-stable pseudo-anonymous ID. Used as the default identity
   * for `track()` / `captureError()` calls where the caller doesn't
   * supply one (e.g. an `uncaughtException` handler has no per-request
   * context). Stable for the SDK instance's lifetime so events from
   * the same process correlate.
   */
  private readonly processAnonymousId: string;

  private readonly runtime: RuntimeInfo;
  private readonly runtimeProperties: Record<string, unknown>;
  private readonly breadcrumbs: BreadcrumbBuffer;
  private readonly eventQueue: EventQueue;
  private readonly errorTracker: ErrorTracker | null;
  private readonly flushOnExit: FlushOnExit | null;
  private readonly superProps: SuperPropertyStore;
  private readonly entitlementCache: EntitlementCache;
  private readonly debug: DebugLogger;

  /**
   * Alias map — `developerUserId` / `anonymousId` → canonical
   * `crossdeckCustomerId`. Populated by `getEntitlements()` so a
   * subsequent `isEntitled({ userId }, "pro")` resolves to the same
   * cache entry the prior `getEntitlements({ userId })` populated.
   *
   * Bounded by `MAX_CUSTOMER_ID_ALIASES` (matches the entitlement
   * cache's default max-customers for symmetry — if the underlying
   * cache entry was evicted, a stale alias is dead weight anyway).
   * Long-running multi-tenant servers handling a long tail of customers
   * are the failure mode this bound defends against.
   */
  private customerIdAliases = new Map<string, string>();

  /** Mutable error-state — modified by setTag / setContext / setErrorBeforeSend. */
  private errorContext: Record<string, unknown> = {};
  private errorTags: Record<string, string> = {};
  private errorBeforeSend: ((err: CapturedError) => CapturedError | null) | null = null;

  constructor(options: CrossdeckServerOptions) {
    super();
    if (!options.secretKey || !options.secretKey.startsWith("cd_sk_")) {
      throw new CrossdeckError({
        type: "configuration_error",
        code: "invalid_secret_key",
        message: "CrossdeckServer requires a secret key starting with cd_sk_.",
      });
    }

    this.sdkVersion = options.sdkVersion ?? SDK_VERSION;
    this.appId = options.appId;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.env = inferEnvFromKey(options.secretKey);
    this.secretKeyPrefix = maskSecretKey(options.secretKey);

    this.http = new HttpClient({
      secretKey: options.secretKey,
      baseUrl: this.baseUrl,
      sdkVersion: this.sdkVersion,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      testMode: options.testMode,
      onRequest: options.onRequest,
      onResponse: options.onResponse,
      httpRetries: options.httpRetries,
      runtimeToken: options.runtimeToken,
    });

    this.processAnonymousId = mintId("anon_node");

    this.runtime = collectRuntimeInfo({
      serviceName: options.serviceName,
      serviceVersion: options.serviceVersion,
      appVersion: options.appVersion,
    });
    this.runtimeProperties = runtimeInfoToProperties(this.runtime);

    this.breadcrumbs = new BreadcrumbBuffer(options.breadcrumbsMaxSize ?? 50);
    this.superProps = new SuperPropertyStore();
    this.entitlementCache = new EntitlementCache({
      ttlMs: options.entitlementCacheTtlMs ?? 60_000,
    });
    this.debug = options.debug === true ? new ConsoleDebugLogger() : new NullDebugLogger();
    if (options.debug === true) this.debug.enabled = true;

    this.debug.emit(
      "sdk.configured",
      `Crossdeck server SDK connected. env=${this.env}, host=${this.runtime?.host ?? "node"}`,
      {
        env: this.env,
        sdkVersion: this.sdkVersion,
        secretKeyPrefix: this.secretKeyPrefix,
      },
    );

    this.eventQueue = new EventQueue({
      http: this.http,
      batchSize: options.eventFlushBatchSize ?? 20,
      intervalMs: options.eventFlushIntervalMs ?? 1500,
      envelope: (): BatchEnvelope => ({
        appId: this.appId,
        sdk: { name: SDK_NAME, version: this.sdkVersion },
      }),
      onDrop: (count) => {
        this.emit("queue.dropped", { count });
      },
      onBufferChange: (size) => {
        this.emit("queue.buffer_changed", { size });
      },
      onRetryScheduled: (info) => {
        this.emit("queue.flush_failed", {
          error: info.lastError,
          attempt: info.consecutiveFailures,
          nextRetryMs: info.delayMs,
        });
      },
      onFirstFlushSuccess: () => {
        this.debug.emit("sdk.first_event_sent", "First batch landed.");
      },
    });

    // Error capture. Default: enabled. Caller can opt out with `false`,
    // or override individual knobs with a partial object.
    if (options.errorCapture === false) {
      this.errorTracker = null;
    } else {
      const config: ErrorCaptureConfig =
        options.errorCapture && typeof options.errorCapture === "object"
          ? { ...DEFAULT_ERROR_CAPTURE, ...options.errorCapture }
          : { ...DEFAULT_ERROR_CAPTURE };
      this.errorTracker = new ErrorTracker({
        config,
        breadcrumbs: this.breadcrumbs,
        report: (err) => this.reportCapturedError(err),
        getContext: () => ({ ...this.errorContext }),
        getTags: () => ({ ...this.errorTags }),
        beforeSend: null, // wired via setErrorBeforeSend; ErrorTracker reads it through the live ref below
        isConsented: () => true,
      });
      // Indirect through `this.errorBeforeSend` so `setErrorBeforeSend`
      // takes effect on subsequent reports without re-installing the
      // tracker.
      const trackerOpts = (this.errorTracker as unknown as { opts: { beforeSend: ((e: CapturedError) => CapturedError | null) | null } }).opts;
      Object.defineProperty(trackerOpts, "beforeSend", {
        get: () => this.errorBeforeSend,
        configurable: true,
      });
      this.errorTracker.install();
    }

    // Flush-on-exit. Default: enabled. Critical for serverless — without
    // this, Cloud Functions / Lambda exit before HTTP completes and events
    // vanish silently.
    if (options.flushOnExit === false) {
      this.flushOnExit = null;
    } else {
      this.flushOnExit = new FlushOnExit({
        drain: () => this.eventQueue.flush().then(() => undefined),
        timeoutMs: options.flushOnExitTimeoutMs,
      });
      this.flushOnExit.install();
    }
  }

  // ============================================================
  // Identity — direct HTTP (transactional, not telemetry)
  // ============================================================

  async identify(
    userId: string,
    anonymousId: string,
    options?: IdentifyOptions & RequestOptions,
  ): Promise<AliasResult> {
    const { signal, timeoutMs, ...identifyOpts } = options ?? {};
    return this.aliasIdentity(
      { userId, anonymousId, ...identifyOpts },
      { signal, timeoutMs },
    );
  }

  async aliasIdentity(
    input: AliasIdentityInput,
    options?: RequestOptions,
  ): Promise<AliasResult> {
    if (!input.userId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_user_id",
        message: "aliasIdentity requires a non-empty userId.",
      });
    }
    if (!input.anonymousId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_anonymous_id",
        message: "aliasIdentity requires a non-empty anonymousId.",
      });
    }

    const traits = sanitizePropertyBag(input.traits, "traits");
    const body: Record<string, unknown> = {
      userId: input.userId,
      anonymousId: input.anonymousId,
    };
    if (input.email) body.email = input.email;
    if (traits && Object.keys(traits).length > 0) body.traits = traits;

    return this.http.request<AliasResult>("POST", "/identity/alias", {
      body,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
  }

  async forget(hints: IdentityHints, options?: RequestOptions): Promise<ForgetResult> {
    const body = this.identityPayload(hints);
    return this.http.request<ForgetResult>("POST", "/identity/forget", {
      body,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
  }

  // ============================================================
  // Entitlements — direct HTTP + TTL cache (v1.0.0+)
  //
  // `getEntitlements()` POSTs over the wire and populates the cache
  // under the response's canonical `crossdeckCustomerId`. Any
  // `userId` / `anonymousId` supplied as a hint is recorded as an
  // alias so a subsequent `isEntitled({ userId }, "pro")` resolves
  // to the same cache entry.
  // ============================================================

  async getEntitlements(
    hints: IdentityHints,
    options?: RequestOptions,
  ): Promise<EntitlementsListResponse> {
    const response = await this.http.request<EntitlementsListResponse>("GET", "/entitlements", {
      query: this.identityPayload(hints),
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
    this.populateEntitlementCache(hints, response);
    return response;
  }

  async getCustomerEntitlements(
    customerId: string,
    options?: RequestOptions,
  ): Promise<EntitlementsListResponse> {
    if (!customerId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_customer_id",
        message: "getCustomerEntitlements requires a customerId.",
      });
    }
    const response = await this.http.request<EntitlementsListResponse>(
      "GET",
      `/server/customers/${encodeURIComponent(customerId)}/entitlements`,
      {
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      },
    );
    this.populateEntitlementCache({ customerId }, response);
    return response;
  }

  /**
   * Synchronous entitlement check. Returns `true` iff the customer
   * has the entitlement AND the cache entry is fresh (within
   * `entitlementCacheTtlMs`, default 60s). Returns `false` when the
   * cache is cold or expired.
   *
   * The hint can be any combination of `customerId` / `userId` /
   * `anonymousId`. After `getEntitlements({ userId })` populates the
   * cache, subsequent `isEntitled({ userId }, "pro")` calls within
   * TTL are memory reads (no HTTP). The "warm cache" pattern that
   * makes hot-path entitlement gates cheap.
   *
   *   await server.getEntitlements({ userId });    // warm
   *   if (server.isEntitled({ userId }, "pro")) {  // synchronous
   *     // ...
   *   }
   *
   * Caller is responsible for re-warming after TTL elapses. The cache
   * does NOT auto-refresh on read (would block the hot path).
   */
  isEntitled(hint: IdentityHints | string, key: string): boolean {
    const customerId = this.resolveCacheCustomerId(hint);
    if (!customerId) return false;
    const result = this.entitlementCache.isEntitled(customerId, key);
    if (result) {
      this.debug.emit("sdk.entitlement_cache_used", `Cache hit for ${customerId}/${key}.`);
    }
    return result;
  }

  /**
   * Snapshot of the customer's cached entitlements. Returns `[]` when
   * the cache is cold or expired. Same hint resolution as
   * `isEntitled()`.
   */
  listEntitlements(hint: IdentityHints | string): PublicEntitlement[] {
    const customerId = this.resolveCacheCustomerId(hint);
    if (!customerId) return [];
    return this.entitlementCache.list(customerId);
  }

  /**
   * Subscribe to entitlement-cache mutations. Listener fires after
   * `getEntitlements()` populates the cache or `shutdown()` clears
   * it. Returns an idempotent unsubscribe function.
   *
   * Used by callers that want to react to entitlement changes (e.g.
   * a websocket layer notifying connected clients of plan upgrades).
   * Listener errors are swallowed — surfaced via
   * `diagnostics().entitlements.listenerErrors`.
   */
  onEntitlementsChange(listener: EntitlementsListener): () => void {
    return this.entitlementCache.subscribe(listener);
  }

  // ============================================================
  // Events — queue-based track(); immediate ingest() for bulk imports
  // ============================================================

  /**
   * Queue an event for batched delivery. Returns synchronously — the
   * HTTP round-trip happens in the background.
   *
   * Behaviour parity with `@cross-deck/web`'s `track()`:
   *   - Synchronous return, void.
   *   - Throws sync on `missing_event_name`.
   *   - Property bag sanitised through `validateEventProperties`.
   *   - Runtime info (`runtime.*`) auto-merged into every event's
   *     properties. Caller-supplied properties win on key collision.
   *   - Breadcrumb auto-emitted (unless the name starts with `error.`,
   *     which would cause a cycle).
   *
   * Differences from `@cross-deck/web`:
   *   - Single-argument signature `track(event)` instead of
   *     `track(name, properties)` — the Node wire shape needs the full
   *     `ServerEvent` (identity hint, optional level + tags + categoryTags).
   *   - Auto-fills `anonymousId` with `this.processAnonymousId` when no
   *     identity hint is supplied. A captureError from
   *     `uncaughtException` has no per-request context; without the
   *     auto-fill, the event would be rejected at queue enqueue.
   */
  track(event: ServerEvent): void {
    if (!event.name) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_event_name",
        message: "track(event) requires a non-empty event.name.",
      });
    }

    const sanitized = sanitizePropertyBag(event.properties, "event properties") ?? {};

    if (this.debug.enabled) {
      const flagged = findSensitivePropertyKeys(sanitized);
      if (flagged.length > 0) {
        this.debug.emit(
          "sdk.sensitive_property_warning",
          `Event "${event.name}" has potentially sensitive property names: ${flagged.join(", ")}. Crossdeck is privacy-first — avoid sending PII unless intentional.`,
          { eventName: event.name, flagged },
        );
      }
    }

    // Enrichment order (parity with web SDK):
    //   1. Runtime info (auto-detected)
    //   2. Super-properties (registered via server.register(...))
    //   3. Group memberships → `$groups.<type>: id` (server.group(...))
    //   4. Caller-supplied properties (sanitised — most authoritative)
    //
    // Caller wins on key collision so a developer-set value overrides
    // anything the SDK auto-attached.
    const properties: EventProperties = {
      ...this.runtimeProperties,
      ...this.superProps.getSuperProperties(),
      ...sanitized,
    };
    const groupIds = this.superProps.getGroupIds();
    if (Object.keys(groupIds).length > 0 && properties.$groups === undefined) {
      properties.$groups = groupIds;
    }

    const identity = this.resolveIdentity(event);

    const queued: QueuedEvent = {
      eventId: event.eventId ?? mintId("evt", 8),
      name: event.name,
      timestamp: event.timestamp ?? Date.now(),
      properties,
      ...identity,
    };
    if (event.level !== undefined) queued.level = event.level;
    if (event.tags !== undefined) queued.tags = event.tags;
    if (event.categoryTags !== undefined) queued.categoryTags = event.categoryTags;

    this.eventQueue.enqueue(queued);

    if (!event.name.startsWith("error.")) {
      this.breadcrumbs.add({
        timestamp: queued.timestamp,
        category: categoryFor(event.name),
        message: event.name,
        data: sanitized,
      });
    }
  }

  /**
   * Immediate POST of one or more events. For bulk imports / replay
   * scenarios where the caller wants synchronous confirmation. Bypasses
   * the queue — no batching, no auto-fill of identity, no
   * runtime-enrichment.
   *
   * Use `track()` for the standard fire-and-forget telemetry path.
   * Use `ingest()` when you need:
   *   - The IngestResponse synchronously.
   *   - Strict per-event identity validation (no auto-fill).
   *   - Caller-controlled idempotency key.
   */
  async ingest(events: ServerEvent[], options: IngestOptions = {}): Promise<IngestResponse> {
    if (!Array.isArray(events) || events.length === 0) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_events",
        message: "ingest requires at least one event.",
      });
    }

    const normalized = events.map((event) => this.normalizeIngestEvent(event));
    const body: Record<string, unknown> = {
      events: normalized,
      sdk: { name: SDK_NAME, version: this.sdkVersion },
    };
    if (this.appId) body.appId = this.appId;

    return this.http.request<IngestResponse>("POST", "/events", {
      body,
      idempotencyKey: options.idempotencyKey ?? mintId("batch"),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  }

  /**
   * Validate the secret key against the Crossdeck API and return the
   * resolved project + app metadata. Useful at boot to fail fast on a
   * misconfigured deployment — without this, a wrong secret key only
   * surfaces on the first event flush attempt, which may be minutes
   * after process start.
   *
   *   const { projectId, appId, env, serverTime } = await server.heartbeat();
   *
   * Throws `CrossdeckError` on:
   *   - `authentication_error` — secret key invalid / revoked
   *   - `network_error` — couldn't reach the backend
   *   - `request_timeout` — backend slow / unreachable
   *
   * Side effect: success records `(serverTime, clientTime)` for clock-
   * skew detection in `diagnostics().clock` (Phase 2 — not yet exposed
   * in this SDK release but the data is captured).
   *
   * Not auto-called. Caller decides whether the trade-off (one extra
   * boot request + ~50ms p50 latency) is worth the early-failure
   * signal. For serverless cold-starts, it usually is — cheap
   * compared to the cost of a silent broken secret in production.
   */
  async heartbeat(options?: RequestOptions): Promise<HeartbeatResponse> {
    const result = await this.http.request<HeartbeatResponse>("GET", "/sdk/heartbeat", {
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
    return result;
  }

  /**
   * Drain the event queue. Resolves when the in-flight batch completes
   * (success or failure). On failure, events stay queued for the next
   * scheduled retry — the resolved promise does NOT throw.
   *
   * Typical callers:
   *   - End of a Lambda handler: `await server.flush()` before return
   *     so events land before the platform freezes the process.
   *   - Express server shutdown: `await server.flush()` inside the
   *     SIGTERM handler.
   *   - Tests: drain between assertions.
   *
   * Idempotent — flush on an empty queue is a no-op.
   */
  async flush(): Promise<void> {
    await this.eventQueue.flush();
  }

  async syncPurchases(
    input: SyncPurchaseInput,
    options?: RequestOptions,
  ): Promise<PurchaseResult> {
    if (!input.signedTransactionInfo) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_signed_transaction_info",
        message: "syncPurchases requires a signedTransactionInfo string.",
      });
    }
    return this.http.request<PurchaseResult>("POST", "/purchases/sync", {
      body: { rail: input.rail ?? "apple", ...input },
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
  }

  // ============================================================
  // Manual entitlement controls + audit — direct HTTP
  // ============================================================

  async grantEntitlement(
    input: GrantEntitlementInput,
    options?: RequestOptions,
  ): Promise<EntitlementMutationResult> {
    if (!input.customerId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_customer_id",
        message: "grantEntitlement requires a customerId.",
      });
    }

    return this.http.request<EntitlementMutationResult>(
      "POST",
      `/server/customers/${encodeURIComponent(input.customerId)}/grant`,
      {
        body: {
          entitlementKey: input.entitlementKey,
          duration: input.duration,
          reason: input.reason,
        },
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      },
    );
  }

  /**
   * Grant multiple entitlements in one logical call. Backend lacks a
   * bulk endpoint today, so this is a client-side fan-out — each
   * grant fires a separate request. Results return as a
   * settled-promise array so partial failures don't drop the rest:
   * the caller decides how to handle each `{ ok, value }` /
   * `{ ok: false, error }` entry.
   *
   * Use for ops sweeps (e.g. "grant the entire `pro` tier a one-time
   * `pro_q1_bonus` entitlement"). The bounded concurrency (default
   * `maxConcurrency: 5`) avoids hammering the backend; the rate-
   * limit policy on the server still kicks in if needed.
   */
  async bulkGrantEntitlement(
    grants: GrantEntitlementInput[],
    options?: RequestOptions & { maxConcurrency?: number },
  ): Promise<Array<{ input: GrantEntitlementInput; ok: true; value: EntitlementMutationResult } | { input: GrantEntitlementInput; ok: false; error: CrossdeckError }>> {
    return runBulkOperation(grants, options?.maxConcurrency ?? 5, (input) =>
      this.grantEntitlement(input, { signal: options?.signal, timeoutMs: options?.timeoutMs }),
    );
  }

  async revokeEntitlement(
    input: RevokeEntitlementInput,
    options?: RequestOptions,
  ): Promise<EntitlementMutationResult> {
    if (!input.customerId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_customer_id",
        message: "revokeEntitlement requires a customerId.",
      });
    }

    return this.http.request<EntitlementMutationResult>(
      "POST",
      `/server/customers/${encodeURIComponent(input.customerId)}/revoke`,
      {
        body: {
          entitlementKey: input.entitlementKey,
          reason: input.reason,
        },
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      },
    );
  }

  /**
   * Revoke multiple entitlements in one logical call. Same
   * settled-array contract as `bulkGrantEntitlement` — see that
   * doc for behaviour notes.
   */
  async bulkRevokeEntitlement(
    revokes: RevokeEntitlementInput[],
    options?: RequestOptions & { maxConcurrency?: number },
  ): Promise<Array<{ input: RevokeEntitlementInput; ok: true; value: EntitlementMutationResult } | { input: RevokeEntitlementInput; ok: false; error: CrossdeckError }>> {
    return runBulkOperation(revokes, options?.maxConcurrency ?? 5, (input) =>
      this.revokeEntitlement(input, { signal: options?.signal, timeoutMs: options?.timeoutMs }),
    );
  }

  async getAuditEntry(eventId: string, options?: RequestOptions): Promise<AuditEntry> {
    if (!eventId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_event_id",
        message: "getAuditEntry requires an eventId.",
      });
    }

    const result = await this.http.request<AuditEntryResponse>(
      "GET",
      `/server/audit/${encodeURIComponent(eventId)}`,
      {
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      },
    );
    return result.data;
  }

  // ============================================================
  // USP 1 — Error capture public surface
  // ============================================================

  /**
   * Manually capture an error from a try/catch block.
   *
   *   try { … } catch (err) {
   *     server.captureError(err, { context: { jobId }, tags: { flow: "checkout" } });
   *   }
   *
   * The error ships through the same event queue analytics rides on
   * (retried, idempotent, runtime-enriched). Returns silently — never
   * throws, even if error capture is disabled.
   */
  captureError(
    error: unknown,
    options?: { context?: Record<string, unknown>; tags?: Record<string, string>; level?: ErrorLevel },
  ): void {
    if (!this.errorTracker) return;
    this.errorTracker.captureError(error, options);
  }

  /**
   * Capture a non-error signal as an issue. Sentry's `captureMessage`
   * pattern — for "we hit the deprecated code path" / "soft-warning
   * triggered" signals where there's no Error to throw.
   */
  captureMessage(message: string, level: ErrorLevel = "info"): void {
    if (!this.errorTracker) return;
    this.errorTracker.captureMessage(message, level);
  }

  /**
   * Attach a tag to every subsequent error report. Sentry pattern.
   * Tags are flat string key/value (queryable in the dashboard);
   * use `setContext()` for structured blobs.
   */
  setTag(key: string, value: string): void {
    this.errorTags[key] = value;
  }

  /** Bulk-set tags. Merges with existing tags. */
  setTags(tags: Record<string, string>): void {
    Object.assign(this.errorTags, tags);
  }

  /**
   * Attach a structured context blob to every subsequent error report.
   * Unlike tags (flat key/value), context is a named bag of arbitrary
   * JSON-serialisable data.
   *
   *   server.setContext("cart", { items: 3, total: 42.99 });
   */
  setContext(name: string, data: Record<string, unknown>): void {
    this.errorContext[name] = data;
  }

  /**
   * Add a custom breadcrumb to the rolling buffer. The last 50
   * breadcrumbs are attached to every subsequent error report —
   * "what was the request doing right before things broke."
   */
  addBreadcrumb(crumb: Breadcrumb): void {
    this.breadcrumbs.add(crumb);
  }

  /**
   * Install a pre-send hook for errors. Return null to drop the report,
   * or a modified `CapturedError` to scrub fields. Sentry's
   * `beforeSend` pattern — the only place to add app-specific PII
   * redaction (auth tokens in URLs, etc.) before the report leaves the
   * process.
   *
   * The hook is called LAST, after rate-limit + sampling + path gates
   * already passed. A throwing hook falls back to the original error.
   */
  setErrorBeforeSend(hook: ((err: CapturedError) => CapturedError | null) | null): void {
    this.errorBeforeSend = hook;
  }

  // ============================================================
  // USP 2 — Super-properties + groups (Mixpanel pattern)
  // ============================================================

  /**
   * Register super-properties — every subsequent event carries these
   * keys on its `properties` bag automatically. Mixpanel pattern.
   *
   *   server.register({ tenant: "acme", plan: "pro" });
   *   server.track({ name: "paywall_shown", developerUserId: userId });
   *   //          ^ event carries `tenant` + `plan` in properties
   *
   * Values that are `null` are deleted (the explicit "stop tracking
   * this key" idiom). Sanitised through `validateEventProperties` so
   * a `{ avatar: <Buffer> }` payload can't poison the queue.
   *
   * Returns a defensive snapshot of the resulting bag.
   *
   * **Multi-tenant servers — read carefully.** Super-properties are
   * PROCESS-SCOPED. In a single Node process handling requests for
   * many tenants (the common multi-tenant SaaS shape), calling
   * `server.register({ tenant: "acme" })` taints EVERY subsequent
   * event from that process — including ones serving tenant "beta".
   * That's almost never what you want.
   *
   * The right pattern for per-request properties is to pass them on
   * the `track()` call itself:
   *
   *   server.track({
   *     name: "paywall_shown",
   *     developerUserId: req.user.id,
   *     properties: { tenant: req.tenantId, plan: req.user.plan },
   *   });
   *
   * Reserve `register()` for properties that genuinely apply to every
   * event from this process — e.g. service version, region, build
   * commit. For those, `runtime-info` already provides
   * `runtime.serviceVersion` etc. automatically.
   */
  register(properties: Record<string, unknown>): Record<string, unknown> {
    const validation = validateEventProperties(properties);
    const result = this.superProps.register(validation.properties);
    this.debug.emit(
      "sdk.super_property_registered",
      `Super-properties updated. ${Object.keys(validation.properties).length} key(s) merged.`,
    );
    return result;
  }

  /** Remove a single super-property key. Idempotent. */
  unregister(key: string): void {
    this.superProps.unregister(key);
  }

  /** Snapshot of the current super-property bag. */
  getSuperProperties(): Record<string, unknown> {
    return this.superProps.getSuperProperties();
  }

  /**
   * Associate the current SDK instance with a group (org, team,
   * account, plan). Mixpanel / Segment Group Analytics pattern.
   *
   *   server.group("org", "acme_inc");
   *   server.group("team", "design", { headcount: 12 });
   *
   * Once set, every subsequent event carries `$groups.<type>: id` on
   * its `properties` bag, enabling B2B dashboard pivots. Pass
   * `id: null` to clear a group membership.
   *
   * Group traits are sanitised through `validateEventProperties`.
   */
  group(type: string, id: string | null, traits?: Record<string, unknown>): void {
    if (!type) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_group_type",
        message: "group(type, id) requires a non-empty type.",
      });
    }
    const sanitisedTraits = traits ? validateEventProperties(traits).properties : undefined;
    this.superProps.setGroup(type, id, sanitisedTraits);
  }

  /** Snapshot of current group memberships keyed by type. */
  getGroups(): Record<string, GroupMembership> {
    return this.superProps.getGroups();
  }

  // ============================================================
  // Diagnostics — for debugging + the dashboard's heartbeat row
  // ============================================================

  diagnostics(): Diagnostics {
    return {
      sdkVersion: this.sdkVersion,
      baseUrl: this.baseUrl,
      secretKeyPrefix: this.secretKeyPrefix,
      env: this.env,
      runtime: {
        nodeVersion: this.runtime.nodeVersion,
        platform: this.runtime.platform,
        hostname: this.runtime.hostname,
        host: this.runtime.host,
        region: this.runtime.region,
        serviceName: this.runtime.serviceName,
        serviceVersion: this.runtime.serviceVersion,
        instanceId: this.runtime.instanceId,
      },
      entitlements: {
        count: this.entitlementCache.customerCount,
        lastUpdated: this.entitlementCache.lastUpdated,
        ttlMs: this.entitlementCache.ttl,
        listenerErrors: this.entitlementCache.listenerErrors,
      },
      events: this.eventQueue.getStats(),
      errors: {
        sessionCount: this.errorTracker?.reportedCount ?? 0,
        fingerprintsTracked: this.errorTracker?.fingerprintsTracked ?? 0,
        handlersInstalled: this.errorTracker?.handlersInstalled ?? false,
      },
    };
  }

  /**
   * Tear down handlers and clear in-memory state. Tests + custom
   * lifecycle callers only. Production code should rely on
   * `flush-on-exit` instead.
   */
  shutdown(reason: "shutdown" | "dispose" | "asyncDispose" = "shutdown"): void {
    this.emit("sdk.shutdown", { reason });
    this.errorTracker?.uninstall();
    this.flushOnExit?.uninstall();
    this.eventQueue.reset();
    this.breadcrumbs.clear();
    this.superProps.clear();
    this.entitlementCache.clear();
    this.customerIdAliases.clear();
    this.errorContext = {};
    this.errorTags = {};
    this.errorBeforeSend = null;
    // Drop all event listeners last — caller's `sdk.shutdown` listeners
    // had a chance to run above.
    this.removeAllListeners();
  }

  // ============================================================
  // Internals
  // ============================================================

  /**
   * Convert a `CapturedError` into a `ServerEvent` and push through
   * `track()`. Goes through the same queue / enrichment / breadcrumb
   * pipeline analytics events do.
   */
  // ============================================================
  // Typed EventEmitter overloads — narrowing for the common methods
  // ============================================================

  override on<K extends keyof CrossdeckServerEvents>(
    event: K,
    listener: (...args: CrossdeckServerEvents[K]) => void,
  ): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  override once<K extends keyof CrossdeckServerEvents>(
    event: K,
    listener: (...args: CrossdeckServerEvents[K]) => void,
  ): this;
  override once(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }

  override off<K extends keyof CrossdeckServerEvents>(
    event: K,
    listener: (...args: CrossdeckServerEvents[K]) => void,
  ): this;
  override off(event: string | symbol, listener: (...args: unknown[]) => void): this;
  override off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }

  override emit<K extends keyof CrossdeckServerEvents>(
    event: K,
    ...args: CrossdeckServerEvents[K]
  ): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  // ============================================================
  // Health + readiness + lifecycle
  // ============================================================

  /**
   * Synchronous readiness check — "is the SDK in a state where it
   * should accept new traffic?". Used by Kubernetes readiness probes
   * and backpressure-aware callers.
   *
   * Returns `false` if:
   *   - The event queue is in a sustained retry storm
   *     (`consecutiveFailures >= 5`).
   *   - The event queue's buffered count is at >= 80% of HARD_BUFFER_CAP.
   *
   * Otherwise `true`. The default isn't "perfectly healthy" — the
   * SDK is happy to enqueue events even during transient flush
   * failures because the queue's retry path handles them. Only
   * sustained failure flips this to `false`.
   */
  isReady(): boolean {
    const stats = this.eventQueue.getStats();
    if (stats.consecutiveFailures >= 5) return false;
    if (stats.buffered >= 800) return false; // 80% of HARD_BUFFER_CAP
    return true;
  }

  /**
   * Async wait until `isReady()` returns true OR the timeout elapses.
   * Resolves `true` on ready, `false` on timeout. Polls every 50ms by
   * default — backpressure for callers writing high-volume servers.
   *
   *   if (!(await server.awaitReady(2000))) {
   *     // shed load — SDK is in a retry storm, don't queue more
   *   }
   */
  async awaitReady(timeoutMs = 5000, pollIntervalMs = 50): Promise<boolean> {
    if (this.isReady()) return true;
    const start = Date.now();
    return new Promise<boolean>((resolve) => {
      const tick = (): void => {
        if (this.isReady()) {
          resolve(true);
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          resolve(false);
          return;
        }
        const t = setTimeout(tick, pollIntervalMs);
        if (typeof t.unref === "function") {
          try {
            t.unref();
          } catch {
            // ignore
          }
        }
      };
      tick();
    });
  }

  /**
   * Snapshot for Kubernetes liveness + readiness probes. `healthy`
   * stays true unless the SDK is in a catastrophic state (which
   * currently can't happen without crashing the process). `ready`
   * matches `isReady()`.
   *
   *   app.get("/healthz", (_req, res) => {
   *     const h = server.getHealth();
   *     res.status(h.healthy ? 200 : 503).json(h);
   *   });
   */
  getHealth(): {
    ready: boolean;
    healthy: boolean;
    bufferedEvents: number;
    inFlight: number;
    consecutiveFailures: number;
    lastFlushAt: number;
    lastError: string | null;
    errorHandlersInstalled: boolean;
  } {
    const stats = this.eventQueue.getStats();
    return {
      ready: this.isReady(),
      healthy: true,
      bufferedEvents: stats.buffered,
      inFlight: stats.inFlight,
      consecutiveFailures: stats.consecutiveFailures,
      lastFlushAt: stats.lastFlushAt,
      lastError: stats.lastError,
      errorHandlersInstalled: this.errorTracker?.handlersInstalled ?? false,
    };
  }

  /**
   * Sync disposal hook — runs when a `using` declaration exits scope
   * (TC39 explicit-resource-management, Node 20+ / TS 5.2+).
   *
   *   using server = new CrossdeckServer({ ... });
   *   // ... use server ...
   *   // at end of block, server[Symbol.dispose]() runs automatically
   *
   * `Symbol.dispose` is synchronous so we can't await `flush()` here
   * — for that, use `await using` + `[Symbol.asyncDispose]()`. This
   * sync variant just calls `shutdown()` (handler cleanup +
   * in-memory state wipe).
   */
  [Symbol.dispose](): void {
    this.shutdown("dispose");
  }

  /**
   * Async disposal hook — runs when an `await using` declaration
   * exits scope. Awaits `flush()` THEN runs `shutdown()`. Use this
   * variant when the caller needs the queue drained before exit
   * (the common case for serverless handlers).
   *
   *   await using server = new CrossdeckServer({ ... });
   */
  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await this.flush();
    } catch {
      // shutdown is best-effort
    }
    this.shutdown("asyncDispose");
  }

  // ============================================================

  private reportCapturedError(captured: CapturedError): void {
    try {
      this.emit("error.captured", {
        fingerprint: captured.fingerprint,
        kind: captured.kind,
        message: captured.message,
      });
    } catch {
      // listener errors don't break the report
    }
    const properties: EventProperties = {
      fingerprint: captured.fingerprint,
      level: captured.level,
      errorType: captured.errorType,
      message: captured.message,
      stack: captured.rawStack ?? undefined,
      frames: captured.frames,
      tags: captured.tags,
      context: captured.context,
      breadcrumbs: captured.breadcrumbs,
      http: captured.http,
    };
    for (const k of Object.keys(properties)) {
      if (properties[k] === undefined) delete properties[k];
    }
    this.track({
      name: captured.kind,
      timestamp: captured.timestamp,
      properties,
      level: captured.level,
      tags: captured.tags,
    });
  }

  /**
   * Populate the entitlement cache from a fresh server response.
   * Records aliases so `userId` / `anonymousId` hints supplied to
   * `getEntitlements()` resolve to the same cache entry on subsequent
   * `isEntitled({ userId }, ...)` calls.
   *
   * Bounds the alias map at MAX_CUSTOMER_ID_ALIASES — once full, the
   * oldest aliases (by insertion order) are evicted FIFO. Symmetric
   * with the entitlement cache's max-customers cap.
   */
  private populateEntitlementCache(
    hints: IdentityHints,
    response: EntitlementsListResponse,
  ): void {
    const customerId = response.crossdeckCustomerId;
    if (!customerId) return;
    this.entitlementCache.setForCustomer(customerId, response.data);
    if (hints.userId) this.touchAlias(hints.userId, customerId);
    if (hints.anonymousId) this.touchAlias(hints.anonymousId, customerId);
    this.debug.emit(
      "sdk.entitlement_cache_warm",
      `Entitlement cache warmed for ${customerId} (${response.data.length} entitlement(s)).`,
    );
    try {
      this.emit("entitlements.warmed", {
        customerId,
        count: response.data.length,
      });
    } catch {
      // listener errors don't break the response path
    }
  }

  private touchAlias(alias: string, customerId: string): void {
    // Delete-and-reinsert so the alias moves to the end of insertion
    // order (LRU "touch").
    this.customerIdAliases.delete(alias);
    this.customerIdAliases.set(alias, customerId);
    while (this.customerIdAliases.size > MAX_CUSTOMER_ID_ALIASES) {
      const oldest = this.customerIdAliases.keys().next().value;
      if (oldest === undefined) break;
      this.customerIdAliases.delete(oldest);
    }
  }

  /**
   * Resolve any hint shape (canonical customerId / userId hint /
   * anonymousId hint / raw string) to a `crossdeckCustomerId` if we
   * have a cache entry for it.
   */
  private resolveCacheCustomerId(hint: IdentityHints | string): string | null {
    if (typeof hint === "string") {
      // String input is treated as a canonical customerId first, then
      // as an alias (a customer's developerUserId / anonymousId).
      if (this.entitlementCache.isFresh(hint)) return hint;
      return this.customerIdAliases.get(hint) ?? null;
    }
    if (hint.customerId) return hint.customerId;
    if (hint.userId) return this.customerIdAliases.get(hint.userId) ?? null;
    if (hint.anonymousId) return this.customerIdAliases.get(hint.anonymousId) ?? null;
    return null;
  }

  private identityPayload(hints: IdentityHints): Record<string, string> {
    const payload: Record<string, string> = {};
    if (typeof hints.customerId === "string" && hints.customerId) {
      payload.customerId = hints.customerId;
    }
    if (typeof hints.userId === "string" && hints.userId) {
      payload.userId = hints.userId;
    }
    if (typeof hints.anonymousId === "string" && hints.anonymousId) {
      payload.anonymousId = hints.anonymousId;
    }
    if (Object.keys(payload).length === 0) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_identity",
        message: "Provide at least one of customerId, userId, or anonymousId.",
      });
    }
    return payload;
  }

  /**
   * Resolve event identity. Caller-supplied wins; falls back to
   * `processAnonymousId` so events from `captureError` /
   * uncaughtException always have at least one identity hint.
   */
  private resolveIdentity(event: ServerEvent): {
    developerUserId?: string;
    anonymousId?: string;
    crossdeckCustomerId?: string;
  } {
    const out: { developerUserId?: string; anonymousId?: string; crossdeckCustomerId?: string } = {};
    if (event.developerUserId) out.developerUserId = event.developerUserId;
    if (event.anonymousId) out.anonymousId = event.anonymousId;
    if (event.crossdeckCustomerId) out.crossdeckCustomerId = event.crossdeckCustomerId;
    if (!out.developerUserId && !out.anonymousId && !out.crossdeckCustomerId) {
      out.anonymousId = this.processAnonymousId;
    }
    return out;
  }

  /**
   * Strict normalisation for `ingest()` — no auto-fill of identity,
   * caller must supply at least one hint per event. Matches v0.1.0
   * behaviour for backward compatibility with bulk-import callers.
   */
  private normalizeIngestEvent(event: ServerEvent): ServerEvent {
    if (!event.name) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_event_name",
        message: "Each event requires a non-empty name.",
      });
    }
    const hasIdentity =
      Boolean(event.developerUserId) ||
      Boolean(event.anonymousId) ||
      Boolean(event.crossdeckCustomerId);
    if (!hasIdentity) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_identity",
        message:
          "Each event requires at least one of developerUserId, anonymousId, or crossdeckCustomerId.",
      });
    }
    const properties = sanitizePropertyBag(event.properties, "event properties");
    return {
      ...event,
      properties,
      eventId: event.eventId ?? mintId("evt", 8),
      timestamp: event.timestamp ?? Date.now(),
    };
  }
}

function sanitizePropertyBag(
  input: Record<string, unknown> | undefined,
  fieldName: string,
): Record<string, unknown> | undefined {
  if (input === undefined) return undefined;
  try {
    return validateEventProperties(input).properties;
  } catch {
    throw new CrossdeckError({
      type: "invalid_request_error",
      code: "serialization_failed",
      message: `${fieldName} could not be serialized.`,
    });
  }
}

/**
 * Map an event name to a breadcrumb category. Mirrors the web SDK's
 * mapping so breadcrumb timelines in error reports look the same
 * regardless of which SDK emitted them.
 */
function categoryFor(name: string): BreadcrumbCategory {
  if (name.startsWith("page.") || name.startsWith("navigation.")) return "navigation";
  if (name.startsWith("element.") || name.startsWith("ui.click")) return "ui.click";
  if (name.startsWith("http.") || name === "request.handled") return "http";
  return "custom";
}

/**
 * Maximum number of `userId` / `anonymousId` → `crossdeckCustomerId`
 * aliases we track. Matches the entitlement cache's default
 * max-customers for symmetry.
 */
const MAX_CUSTOMER_ID_ALIASES = 10_000;

/**
 * Infer environment from the secret-key prefix. Stripe pattern —
 * `cd_sk_live_*` means production, anything else is treated as sandbox
 * (fixture / test keys typically use `cd_sk_test_*` but bare
 * `cd_sk_*` from test fixtures also falls here).
 */
function inferEnvFromKey(secretKey: string): Environment {
  return secretKey.startsWith("cd_sk_live_") ? "production" : "sandbox";
}

/**
 * Bounded-concurrency promise-settle helper for bulk operations.
 * Returns one entry per input, in input order. Each entry is either
 * `{ ok: true, value }` or `{ ok: false, error }`. Never rejects —
 * partial failures don't drop the rest of the batch.
 */
async function runBulkOperation<TInput, TResult>(
  inputs: TInput[],
  maxConcurrency: number,
  op: (input: TInput) => Promise<TResult>,
): Promise<Array<{ input: TInput; ok: true; value: TResult } | { input: TInput; ok: false; error: CrossdeckError }>> {
  const results: Array<
    | { input: TInput; ok: true; value: TResult }
    | { input: TInput; ok: false; error: CrossdeckError }
  > = new Array(inputs.length);
  let cursor = 0;
  const workers = new Array(Math.min(maxConcurrency, Math.max(1, inputs.length)))
    .fill(0)
    .map(async () => {
      while (true) {
        const index = cursor++;
        if (index >= inputs.length) return;
        const input = inputs[index]!;
        try {
          const value = await op(input);
          results[index] = { input, ok: true, value };
        } catch (err) {
          results[index] = {
            input,
            ok: false,
            error:
              err instanceof CrossdeckError
                ? err
                : new CrossdeckError({
                    type: "internal_error",
                    code: "bulk_operation_failed",
                    message: err instanceof Error ? err.message : String(err),
                  }),
          };
        }
      }
    });
  await Promise.all(workers);
  return results;
}

/**
 * Mask the secret key for safe display in diagnostics + logs. Stripe
 * pattern: keep the env-revealing prefix (`cd_sk_test_` / `cd_sk_live_`),
 * replace the middle with `****`, append the last 4 chars when the key
 * is long enough that those 4 chars don't overlap the prefix. Test
 * fixtures with short keys degrade gracefully to `prefix + ****` with
 * no tail.
 */
function maskSecretKey(secretKey: string): string {
  const m = secretKey.match(/^cd_sk_(test|live)_/);
  const prefix = m ? m[0] : secretKey.slice(0, 11);
  const tail = secretKey.length > prefix.length + 4 ? secretKey.slice(-4) : "";
  return `${prefix}****${tail}`;
}
