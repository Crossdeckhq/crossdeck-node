/**
 * Local event queue + batched flush.
 *
 * Why a queue: `track()` is called from hot paths (request handlers,
 * Lambda invocations) and shouldn't block the caller on a network
 * round-trip. Events go into a local buffer, flushed in bursts.
 *
 * Flush triggers:
 *   - Buffer reaches `batchSize` (default 20) → flush immediately.
 *   - `intervalMs` of inactivity (default 1500ms) → flush idle batch.
 *   - `flush()` called explicitly (e.g. from `flush-on-exit.ts` before
 *      a Cloud Function exits, or before a Lambda handler returns).
 *
 * Bank-grade hardening (parity with `@cross-deck/web/src/event-queue.ts`):
 *   - Exponential backoff with full jitter on flush failures. Honours
 *     server `Retry-After` (parsed onto `CrossdeckError` by the HTTP
 *     layer). Replaces the prior policy of "retry on the next idle
 *     window" which hot-looped against a flapping endpoint.
 *   - Per-batch `Idempotency-Key`. The SAME key is reused across
 *     retries of the SAME batch so the server can short-circuit
 *     duplicate work without inspecting bodies. The backend ALSO
 *     dedupes individual events via ClickHouse ReplacingMergeTree on
 *     `eventId`, so this is belt-and-suspenders.
 *
 * Node differences from web:
 *   - No `keepalive` option (Node has no page unload concept).
 *   - No `persistentStore` (no localStorage; Node deployments are
 *     stateless — Lambda freezes between invocations, Cloud Functions
 *     tear down containers). On-exit drainage is handled by the
 *     separate `flush-on-exit.ts` module that calls `flush()` from
 *     `process.on('beforeExit')` + SIGTERM + SIGINT handlers.
 *   - Default scheduler uses `setTimeout(...).unref()` — already
 *     Node-friendly, so a pending flush doesn't block the process
 *     from exiting between invocations.
 *
 * On a permanent network outage we keep retrying with bounded backoff;
 * we never drop events because of network failures alone. The only
 * drop path is the hard buffer cap (1000 events): once exceeded we
 * evict the OLDEST events and increment `dropped` so the developer
 * can see the loss in `diagnostics()`.
 */

import type { HttpClient } from "./http";
import type { EventProperties, IngestResponse } from "./types";
import type { CrossdeckError } from "./errors";
import { RetryPolicy, type RetryPolicyOptions } from "./retry-policy";
import { mintId } from "./_rand";

const HARD_BUFFER_CAP = 1000;

export interface QueuedEvent {
  eventId: string;
  name: string;
  timestamp: number;
  properties: EventProperties;
  // identity hint — at least one of these is always set per-event for
  // Node (the caller supplies them; the SDK doesn't mint anonymousId).
  developerUserId?: string;
  anonymousId?: string;
  crossdeckCustomerId?: string;
  /** Optional Sentry-style level for error.* events. */
  level?: "error" | "warning" | "info";
  /** Optional Sentry-style tag bag for error.* events. */
  tags?: Record<string, string>;
  /** Optional categoryTags column projection on the backend. */
  categoryTags?: string[];
}

export interface BatchEnvelope {
  /** Optional appId. The server is authoritative via the API key; this is metadata only. */
  appId?: string;
  /**
   * Declared environment ("production" / "sandbox"). The backend
   * cross-checks this against the API-key-derived env and rejects
   * mismatches loudly (env_mismatch) — catches the "live key, env:
   * sandbox in caller code" config drift before it pollutes the
   * wrong dashboard. Web has always sent this; node now matches so
   * defence-in-depth is symmetric across SDKs (cross-SDK parity P1
   * audit finding).
   */
  environment?: "production" | "sandbox";
  sdk: { name: string; version: string };
}

export interface EventQueueConfig {
  http: HttpClient;
  batchSize: number;
  intervalMs: number;
  /**
   * Returns the batch envelope to attach to each POST. Function (not
   * a value) so a future config swap can update it without
   * re-instantiating the queue.
   */
  envelope: () => BatchEnvelope;
  /** Schedule a function to run after `ms` ms. Default: setTimeout with .unref(). Override for tests. */
  scheduler?: (fn: () => void, ms: number) => () => void;
  /** Called when the SDK drops events because the buffer is full. */
  onDrop?: (dropped: number) => void;
  /** Called once after the first successful flush — drives the §16 "First event sent" debug signal. */
  onFirstFlushSuccess?: () => void;
  /** Retry policy overrides for failed flushes. */
  retry?: RetryPolicyOptions;
  /**
   * Called whenever an item is added to the buffer or removed by a
   * successful flush. Exposed so the host SDK can surface live queue
   * stats via `diagnostics()` without polling.
   */
  onBufferChange?: (size: number) => void;
  /**
   * Fired (async, never throws) whenever the retry policy schedules
   * the next flush attempt. Used by the SDK debug logger to surface
   * "flush failed, retrying in Xms" signals.
   */
  onRetryScheduled?: (info: {
    delayMs: number;
    consecutiveFailures: number;
    retryAfterMs?: number;
    lastError: string;
  }) => void;
  /**
   * Fired when the queue DROPS a batch because the server returned a
   * permanent 4xx (anything except 408 Request Timeout / 429 Too Many
   * Requests). The host SDK should surface this loudly — pre-fix the
   * queue retried 4xx errors forever with the same Idempotency-Key,
   * silently growing the backlog while the customer thought events
   * were landing. Common causes:
   *   - 401: secret key revoked / rotated
   *   - 403: lacking permission for the project
   *   - 400/422: malformed batch (schema mismatch, oversized event)
   *   - 404: endpoint doesn't exist (typo'd baseUrl)
   */
  onPermanentFailure?: (info: {
    status: number;
    droppedCount: number;
    lastError: string;
  }) => void;
}

export interface EventQueueStats {
  buffered: number;
  dropped: number;
  inFlight: number;
  lastFlushAt: number;
  lastError: string | null;
  /** Consecutive flush failures since the last success. */
  consecutiveFailures: number;
  /** Set when the next flush is scheduled by the retry policy. */
  nextRetryAt: number | null;
}

export class EventQueue {
  private buffer: QueuedEvent[] = [];
  private dropped = 0;
  private inFlight = 0;
  private lastFlushAt = 0;
  private lastError: string | null = null;
  private cancelTimer: (() => void) | null = null;
  private firstFlushFired = false;
  private nextRetryAt: number | null = null;
  private readonly retry: RetryPolicy;
  /**
   * Stable Idempotency-Key for the current in-flight batch. Minted
   * lazily inside `flush()` when no key is pending. Reused across
   * retries of the same logical batch so the backend's idempotency
   * layer can short-circuit duplicates (Stripe pattern). Reset to
   * `null` after a successful flush.
   */
  private pendingBatchId: string | null = null;
  /**
   * In-flight events that have been spliced from the buffer for the
   * current batch but haven't yet been confirmed (success or final
   * failure). On a retry-driven flush, we re-use this batch alongside
   * `pendingBatchId` instead of re-splicing. New events that arrive
   * during in-flight are buffered separately and join the next batch
   * AFTER this one settles.
   */
  private pendingBatch: QueuedEvent[] | null = null;

  constructor(private readonly cfg: EventQueueConfig) {
    this.retry = new RetryPolicy(cfg.retry ?? {});
  }

  enqueue(event: QueuedEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > HARD_BUFFER_CAP) {
      const overflow = this.buffer.length - HARD_BUFFER_CAP;
      this.buffer.splice(0, overflow);
      this.dropped += overflow;
      this.cfg.onDrop?.(overflow);
    }
    this.cfg.onBufferChange?.(this.buffer.length);
    if (this.buffer.length >= this.cfg.batchSize) {
      void this.flush();
    } else {
      this.scheduleIdleFlush();
    }
  }

  /**
   * Flush the buffer to /v1/events. Resolves when the network call
   * completes (success or failure). On failure, events stay in the
   * `pendingBatch` slot for the next scheduled retry — the SAME batch
   * with the SAME `Idempotency-Key` is re-sent (Stripe pattern).
   *
   * The `pendingBatch` slot guarantees retry semantics:
   *   - First call: splices buffer → pendingBatch + mints batchId.
   *   - On 5xx / network failure: pendingBatch stays; scheduler fires
   *     `flush()` again later, which re-uses pendingBatch + the same
   *     batchId.
   *   - On success: pendingBatch + batchId cleared; subsequent calls
   *     splice the buffer again with a fresh batchId.
   *
   * New events that arrive during an in-flight batch land in `buffer`
   * (separate from `pendingBatch`) and ship on the next batch after
   * this one settles. Strict ordering preserved.
   */
  async flush(): Promise<IngestResponse | null> {
    // Resume an in-flight batch retry path: if we already have a
    // pending batch (a prior flush failed and we're being re-invoked
    // by the retry timer or the caller), re-attempt with the SAME
    // batchId. This is the Idempotency-Key reuse contract.
    let batch: QueuedEvent[];
    let batchId: string;
    if (this.pendingBatch !== null && this.pendingBatchId !== null) {
      batch = this.pendingBatch;
      batchId = this.pendingBatchId;
    } else {
      if (this.buffer.length === 0) return null;
      batch = this.buffer.splice(0);
      batchId = mintId("batch");
      this.pendingBatch = batch;
      this.pendingBatchId = batchId;
      this.inFlight += batch.length;
      this.cfg.onBufferChange?.(this.buffer.length);
    }
    this.cancelTimerIfSet();
    this.nextRetryAt = null;

    try {
      const env = this.cfg.envelope();
      const body: Record<string, unknown> = {
        events: batch,
        sdk: env.sdk,
      };
      if (env.appId) body.appId = env.appId;
      // environment ships when the host SDK supplied one (server SDKs
      // know their env from init() options). Backend cross-checks it
      // against the API-key-derived env and rejects mismatches loudly
      // (env_mismatch) — defence-in-depth so a "live key, env: sandbox"
      // misconfig doesn't pollute the wrong dashboard. Parity with web.
      if (env.environment) body.environment = env.environment;
      const result = await this.cfg.http.request<IngestResponse>("POST", "/events", {
        body,
        idempotencyKey: batchId,
      });
      this.lastFlushAt = Date.now();
      this.lastError = null;
      this.inFlight -= batch.length;
      this.pendingBatch = null;
      this.pendingBatchId = null;
      this.retry.recordSuccess();
      if (!this.firstFlushFired) {
        this.firstFlushFired = true;
        this.cfg.onFirstFlushSuccess?.();
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;

      // Permanent failures (4xx except 408/429) are NOT retryable. The
      // server is telling us our request is malformed (400/422), our
      // key is revoked (401), we lack permission (403), or the endpoint
      // doesn't exist (404). Retrying with the same Idempotency-Key
      // forever just grows the queue silently while the customer thinks
      // events are landing. Drop the batch loudly.
      if (isPermanent4xx(err)) {
        const droppedCount = batch.length;
        this.pendingBatch = null;
        this.pendingBatchId = null;
        this.inFlight -= droppedCount;
        this.dropped += droppedCount;
        this.cfg.onDrop?.(droppedCount);
        this.cfg.onPermanentFailure?.({
          status: (err as { status?: number }).status ?? 0,
          droppedCount,
          lastError: message,
        });
        return null;
      }

      // Retryable failure (5xx / network / 408 / 429). Keep
      // `pendingBatch` + `pendingBatchId` set — the next
      // scheduler-driven (or caller-driven) flush will retry with the
      // SAME key. This is the Idempotency-Key reuse contract.
      const retryAfterMs = extractRetryAfterMs(err);
      const delay = this.retry.nextDelay(retryAfterMs);
      this.scheduleRetry(delay);
      this.cfg.onRetryScheduled?.({
        delayMs: delay,
        consecutiveFailures: this.retry.consecutiveFailures,
        retryAfterMs,
        lastError: message,
      });
      return null;
    }
  }

  /** Cancel any pending timer and clear in-memory state. */
  reset(): void {
    this.cancelTimerIfSet();
    this.nextRetryAt = null;
    this.buffer = [];
    this.pendingBatch = null;
    this.pendingBatchId = null;
    this.dropped = 0;
    this.inFlight = 0;
    this.lastError = null;
    this.retry.recordSuccess();
    this.cfg.onBufferChange?.(0);
    // Note: we deliberately do NOT reset firstFlushFired — the
    // "First event sent" signal is a one-time per-process lifetime
    // moment, not per-identity.
  }

  getStats(): EventQueueStats {
    return {
      // `buffered` counts events waiting for their FIRST flush. The
      // in-flight pendingBatch (retrying) is tracked separately via
      // `inFlight` — surfacing both lets diagnostics show "we have
      // events stuck retrying" distinct from "new events arriving".
      buffered: this.buffer.length,
      dropped: this.dropped,
      inFlight: this.inFlight,
      lastFlushAt: this.lastFlushAt,
      lastError: this.lastError,
      consecutiveFailures: this.retry.consecutiveFailures,
      nextRetryAt: this.nextRetryAt,
    };
  }

  /**
   * The Idempotency-Key of the in-flight pending batch (if any).
   * Exposed for testing the Stripe-style reuse contract. Production
   * callers don't need this.
   */
  get pendingIdempotencyKey(): string | null {
    return this.pendingBatchId;
  }

  // ---------- internal scheduling ----------

  private scheduleIdleFlush(): void {
    this.cancelTimerIfSet();
    const sched = this.cfg.scheduler ?? defaultScheduler;
    this.cancelTimer = sched(() => {
      void this.flush();
    }, this.cfg.intervalMs);
  }

  private scheduleRetry(delayMs: number): void {
    this.cancelTimerIfSet();
    this.nextRetryAt = Date.now() + delayMs;
    const sched = this.cfg.scheduler ?? defaultScheduler;
    this.cancelTimer = sched(() => {
      void this.flush();
    }, delayMs);
  }

  private cancelTimerIfSet(): void {
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
  }
}

function extractRetryAfterMs(err: unknown): number | undefined {
  if (err && typeof err === "object" && "retryAfterMs" in err) {
    const v = (err as CrossdeckError).retryAfterMs;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  }
  return undefined;
}

/**
 * True when the error represents a permanent 4xx response that
 * SHOULDN'T be retried. Excludes 408 Request Timeout and 429 Too Many
 * Requests — both indicate transient state where the SAME request
 * (with the SAME Idempotency-Key) can succeed on a retry.
 *
 * Anything that isn't a CrossdeckError-shaped object with a numeric
 * status field returns false (network errors / fetch failures fall
 * here — those ARE retryable). Conservative default: only flag as
 * permanent when we have strong evidence from the server.
 */
function isPermanent4xx(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status !== "number" || !Number.isFinite(status)) return false;
  if (status < 400 || status >= 500) return false;
  if (status === 408 || status === 429) return false;
  return true;
}

/**
 * Default scheduler — `setTimeout` with `.unref()` so a pending flush
 * does NOT keep the Node process alive. Critical for short-lived
 * runtimes (Lambda, Cloud Functions) — without `.unref()`, an
 * outstanding retry timer would prevent `process.exit` from firing
 * naturally and the function would hang until the platform's SIGKILL.
 */
function defaultScheduler(fn: () => void, ms: number): () => void {
  const id = setTimeout(fn, ms);
  if (typeof id.unref === "function") {
    try {
      id.unref();
    } catch {
      // ignore — unref is best-effort
    }
  }
  return () => clearTimeout(id);
}
