import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventQueue, type BatchEnvelope, type QueuedEvent } from "../src/event-queue";
import { HttpClient } from "../src/http";

function makeHttp(): HttpClient {
  return new HttpClient({
    secretKey: "cd_sk_test_x",
    baseUrl: "https://api.cross-deck.test/v1",
    sdkVersion: "test",
    timeoutMs: 0,
  });
}

function envelope(): BatchEnvelope {
  return { appId: "app_x", sdk: { name: "@cross-deck/node", version: "test" } };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function makeEvent(name: string, i = 0): QueuedEvent {
  return {
    eventId: `evt_${name}_${i}`,
    name,
    timestamp: 1_700_000_000_000 + i,
    properties: {},
    anonymousId: "anon_test",
  };
}

/** A scheduler that captures the latest scheduled callback without firing it. */
function captureScheduler() {
  let lastScheduled: { fn: () => void; ms: number } | null = null;
  const calls: Array<{ fn: () => void; ms: number }> = [];
  const scheduler = (fn: () => void, ms: number): (() => void) => {
    lastScheduled = { fn, ms };
    calls.push({ fn, ms });
    return () => {
      // cancel = no-op for captureScheduler
    };
  };
  return {
    scheduler,
    get last(): { fn: () => void; ms: number } | null {
      return lastScheduled;
    },
    get callCount(): number {
      return calls.length;
    },
    fireLast: (): void => {
      if (lastScheduled) lastScheduled.fn();
    },
  };
}

describe("EventQueue — basic enqueue + flush", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("enqueue() buffers without firing HTTP", () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const sched = captureScheduler();
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 10,
      intervalMs: 1500,
      envelope,
      scheduler: sched.scheduler,
    });
    q.enqueue(makeEvent("a"));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(q.getStats().buffered).toBe(1);
  });

  it("buffer reaching batchSize triggers an immediate flush", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 3, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const sched = captureScheduler();
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 3,
      intervalMs: 1500,
      envelope,
      scheduler: sched.scheduler,
    });
    q.enqueue(makeEvent("a", 1));
    q.enqueue(makeEvent("a", 2));
    q.enqueue(makeEvent("a", 3));
    // Async flush triggered — wait for the microtask + fetch.
    await new Promise((r) => setImmediate(r));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("flush() POSTs /events with Idempotency-Key: batch_<rand>", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 100,
      intervalMs: 60_000,
      envelope,
      scheduler: captureScheduler().scheduler,
    });
    q.enqueue(makeEvent("a"));
    await q.flush();

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("/events");
    expect(init.headers["Idempotency-Key"]).toMatch(/^batch_/);
  });

  it("flush() returns null when the buffer is empty", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 100,
      intervalMs: 60_000,
      envelope,
      scheduler: captureScheduler().scheduler,
    });
    const result = await q.flush();
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flush() resolves after the network call completes", async () => {
    let resolveFetch: ((r: Response) => void) | null = null;
    const pending = new Promise<Response>((r) => {
      resolveFetch = r;
    });
    globalThis.fetch = vi.fn().mockReturnValue(pending) as unknown as typeof fetch;

    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 100,
      intervalMs: 60_000,
      envelope,
      scheduler: captureScheduler().scheduler,
    });
    q.enqueue(makeEvent("a"));
    const flushPromise = q.flush();
    // Let the flush race start; it should be pending on fetch.
    let settled = false;
    void flushPromise.then(() => {
      settled = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    resolveFetch!(jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202));
    await flushPromise;
    expect(settled).toBe(true);
  });
});

describe("EventQueue — retry + Idempotency-Key reuse", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("retried flush of the SAME batch reuses the SAME Idempotency-Key (Stripe pattern)", async () => {
    let attempts = 0;
    const fetchSpy = vi.fn().mockImplementation(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve(
          jsonResponse({ error: { type: "internal_error", code: "boom", message: "boom" } }, 500),
        );
      }
      return Promise.resolve(jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202));
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const sched = captureScheduler();
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 100,
      intervalMs: 60_000,
      envelope,
      scheduler: sched.scheduler,
    });
    q.enqueue(makeEvent("a"));
    await q.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstKey = (fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> }).headers[
      "Idempotency-Key"
    ];
    expect(firstKey).toMatch(/^batch_/);
    // After failure, events live in the in-flight pendingBatch slot,
    // NOT back in the outer buffer. The Idempotency-Key is preserved
    // for retry.
    expect(q.getStats().buffered).toBe(0);
    expect(q.pendingIdempotencyKey).toBe(firstKey);
    expect(sched.last).not.toBeNull();

    // Second attempt — the SAME pendingBatch + SAME batchId go on the
    // wire. This is the load-bearing Stripe pattern.
    await q.flush();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondKey = (fetchSpy.mock.calls[1]![1] as { headers: Record<string, string> }).headers[
      "Idempotency-Key"
    ];
    expect(secondKey).toBe(firstKey);
    // After success, the in-flight slot clears.
    expect(q.pendingIdempotencyKey).toBeNull();
  });

  it("failed flush keeps the batch in the in-flight slot — not back in buffer (preserves order via retry)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: { type: "internal_error", code: "boom", message: "boom" } },
        500,
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const sched = captureScheduler();
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 100,
      intervalMs: 60_000,
      envelope,
      scheduler: sched.scheduler,
    });
    q.enqueue(makeEvent("a", 1));
    q.enqueue(makeEvent("a", 2));
    q.enqueue(makeEvent("a", 3));
    await q.flush();
    // Buffer is empty — events are pending in the in-flight slot.
    expect(q.getStats().buffered).toBe(0);
    expect(q.pendingIdempotencyKey).not.toBeNull();
    expect(q.getStats().inFlight).toBe(3);
  });

  it("events enqueued during an in-flight retry land in a SEPARATE batch (after pendingBatch settles)", async () => {
    let attempts = 0;
    const fetchSpy = vi.fn().mockImplementation(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve(
          jsonResponse({ error: { type: "internal_error", code: "boom", message: "boom" } }, 500),
        );
      }
      return Promise.resolve(jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202));
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const sched = captureScheduler();
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 100,
      intervalMs: 60_000,
      envelope,
      scheduler: sched.scheduler,
    });
    q.enqueue(makeEvent("first", 1));
    await q.flush(); // fails — pendingBatch holds "first"

    // Enqueue a SECOND event while the first is in-flight retry state.
    q.enqueue(makeEvent("second", 2));
    expect(q.getStats().buffered).toBe(1); // second event is in buffer
    expect(q.pendingIdempotencyKey).not.toBeNull();

    // Retry succeeds — pendingBatch ships with original key.
    await q.flush();
    expect(q.pendingIdempotencyKey).toBeNull();
    expect(q.getStats().buffered).toBe(1); // "second" still queued

    // Third flush ships the SECOND event with a NEW batchId.
    await q.flush();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const firstKey = (fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> }).headers[
      "Idempotency-Key"
    ];
    const secondKey = (fetchSpy.mock.calls[1]![1] as { headers: Record<string, string> }).headers[
      "Idempotency-Key"
    ];
    const thirdKey = (fetchSpy.mock.calls[2]![1] as { headers: Record<string, string> }).headers[
      "Idempotency-Key"
    ];
    // First retry reuses firstKey (same batch).
    expect(secondKey).toBe(firstKey);
    // Third flush is a NEW batch — new key.
    expect(thirdKey).not.toBe(firstKey);
  });

  it("failed flush schedules a retry through RetryPolicy with delay", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ error: { type: "internal_error", code: "boom", message: "boom" } }, 500),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const sched = captureScheduler();
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 100,
      intervalMs: 60_000,
      envelope,
      scheduler: sched.scheduler,
    });
    q.enqueue(makeEvent("a"));
    await q.flush();
    expect(sched.last).not.toBeNull();
    expect(sched.last!.ms).toBeGreaterThanOrEqual(0);
    expect(q.getStats().consecutiveFailures).toBe(1);
    expect(q.getStats().nextRetryAt).toBeTypeOf("number");
  });

  it("Retry-After header on 429 is honoured when larger than the computed backoff", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: { type: "rate_limit_error", code: "rate_limited", message: "slow down" } },
        429,
        { "Retry-After": "30" }, // 30 seconds → 30_000 ms
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const sched = captureScheduler();
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 100,
      intervalMs: 60_000,
      envelope,
      scheduler: sched.scheduler,
    });
    q.enqueue(makeEvent("a"));
    await q.flush();
    // First-attempt computed backoff: base=1000, jittered 0-1000. Server
    // says 30_000 — server wins (well above the computed ceiling).
    expect(sched.last!.ms).toBe(30_000);
  });
});

describe("EventQueue — overflow + lifecycle", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("buffer exceeding HARD_BUFFER_CAP (1000) evicts oldest events and fires onDrop(n)", () => {
    const onDrop = vi.fn();
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 100_000,
      intervalMs: 60_000,
      envelope,
      scheduler: captureScheduler().scheduler,
      onDrop,
    });
    // Push 1100 events — first 100 get evicted.
    for (let i = 0; i < 1100; i++) {
      q.enqueue(makeEvent("a", i));
    }
    expect(q.getStats().buffered).toBe(1000);
    expect(q.getStats().dropped).toBe(100);
    expect(onDrop).toHaveBeenCalled();
  });

  it("reset() cancels the pending timer, wipes the buffer, and resets the retry counter", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ error: { type: "internal_error", code: "boom", message: "boom" } }, 500),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const sched = captureScheduler();
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 100,
      intervalMs: 60_000,
      envelope,
      scheduler: sched.scheduler,
    });
    q.enqueue(makeEvent("a"));
    await q.flush();
    expect(q.getStats().consecutiveFailures).toBe(1);

    q.reset();
    const stats = q.getStats();
    expect(stats.buffered).toBe(0);
    expect(stats.dropped).toBe(0);
    expect(stats.inFlight).toBe(0);
    expect(stats.lastError).toBeNull();
    expect(stats.consecutiveFailures).toBe(0);
  });

  it("getStats() returns the full diagnostics shape", () => {
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 100,
      intervalMs: 60_000,
      envelope,
      scheduler: captureScheduler().scheduler,
    });
    const s = q.getStats();
    expect(s).toMatchObject({
      buffered: 0,
      dropped: 0,
      inFlight: 0,
      lastFlushAt: 0,
      lastError: null,
      consecutiveFailures: 0,
      nextRetryAt: null,
    });
  });

  it("onFirstFlushSuccess fires exactly once per queue lifetime", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const onFirst = vi.fn();
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 100,
      intervalMs: 60_000,
      envelope,
      scheduler: captureScheduler().scheduler,
      onFirstFlushSuccess: onFirst,
    });
    q.enqueue(makeEvent("a"));
    await q.flush();
    q.enqueue(makeEvent("b"));
    await q.flush();
    expect(onFirst).toHaveBeenCalledTimes(1);
  });

  it("onBufferChange fires on every enqueue and successful flush", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const onBufferChange = vi.fn();
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 100,
      intervalMs: 60_000,
      envelope,
      scheduler: captureScheduler().scheduler,
      onBufferChange,
    });
    q.enqueue(makeEvent("a"));
    q.enqueue(makeEvent("b"));
    await q.flush();
    // Three calls: two enqueues (1, 2), one post-flush (0).
    expect(onBufferChange).toHaveBeenCalledTimes(3);
    expect(onBufferChange).toHaveBeenLastCalledWith(0);
  });

  it("onRetryScheduled fires with delay, attempts, and lastError on flush failure", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ error: { type: "internal_error", code: "boom", message: "boom" } }, 500),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const onRetryScheduled = vi.fn();
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 100,
      intervalMs: 60_000,
      envelope,
      scheduler: captureScheduler().scheduler,
      onRetryScheduled,
    });
    q.enqueue(makeEvent("a"));
    await q.flush();
    expect(onRetryScheduled).toHaveBeenCalledTimes(1);
    const info = onRetryScheduled.mock.calls[0]![0];
    expect(info.consecutiveFailures).toBe(1);
    expect(info.lastError).toBeTypeOf("string");
    expect(info.delayMs).toBeGreaterThanOrEqual(0);
  });
});

describe("EventQueue — permanent failure on 4xx (P0 #6)", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function jsonError(status: number, code: string): Response {
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", code, message: `HTTP ${status}` } }),
      { status, headers: { "Content-Type": "application/json" } },
    );
  }

  it("drops the batch and fires onPermanentFailure on 401 (key revoked)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonError(401, "invalid_api_key")) as unknown as typeof fetch;

    const onDrop = vi.fn();
    const onPermanentFailure = vi.fn();
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 2,
      intervalMs: 10_000,
      envelope,
      // The captured scheduler captures BOTH the idle-flush schedule
      // (fired by the first enqueue when buffer length < batchSize)
      // AND any retry schedules. We don't care about the idle one —
      // we care that the queue didn't schedule a RETRY after the
      // permanent failure. `getStats().nextRetryAt === null` is the
      // canonical signal for that.
      scheduler: () => () => {},
      onDrop,
      onPermanentFailure,
    });
    q.enqueue(makeEvent("a"));
    q.enqueue(makeEvent("b"));
    await q.flush();
    expect(onDrop).toHaveBeenCalledWith(2);
    expect(onPermanentFailure).toHaveBeenCalledTimes(1);
    const info = onPermanentFailure.mock.calls[0]![0];
    expect(info.status).toBe(401);
    expect(info.droppedCount).toBe(2);
    // CRITICAL: no retry scheduled — the whole point of the fix.
    expect(q.getStats().nextRetryAt).toBeNull();
    expect(q.getStats().consecutiveFailures).toBe(0);
    expect(q.getStats().buffered).toBe(0);
    expect(q.getStats().inFlight).toBe(0);
    expect(q.getStats().dropped).toBe(2);
    expect(q.pendingIdempotencyKey).toBeNull();
  });

  it("drops on 400 (malformed batch)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonError(400, "invalid_event")) as unknown as typeof fetch;
    const onPermanentFailure = vi.fn();
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 1,
      intervalMs: 10_000,
      envelope,
      scheduler: captureScheduler().scheduler,
      onPermanentFailure,
    });
    q.enqueue(makeEvent("a"));
    await q.flush();
    expect(onPermanentFailure).toHaveBeenCalledTimes(1);
    expect(onPermanentFailure.mock.calls[0]![0].status).toBe(400);
  });

  it("RETAINS the batch on 408 (transient timeout — retryable)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonError(408, "request_timeout")) as unknown as typeof fetch;
    const sched = captureScheduler();
    const onPermanentFailure = vi.fn();
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 1,
      intervalMs: 10_000,
      envelope,
      scheduler: sched.scheduler,
      onPermanentFailure,
    });
    q.enqueue(makeEvent("a"));
    await q.flush();
    expect(onPermanentFailure).not.toHaveBeenCalled();
    expect(sched.callCount).toBe(1);
    expect(q.getStats().inFlight).toBe(1);
    expect(q.pendingIdempotencyKey).toMatch(/^batch_/);
  });

  it("RETAINS the batch on 429 (rate-limited — retryable, honours Retry-After)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { type: "rate_limit_error", code: "rate_limited", message: "slow" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "3" },
      }),
    ) as unknown as typeof fetch;
    const sched = captureScheduler();
    const onPermanentFailure = vi.fn();
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 1,
      intervalMs: 10_000,
      envelope,
      scheduler: sched.scheduler,
      onPermanentFailure,
    });
    q.enqueue(makeEvent("a"));
    await q.flush();
    expect(onPermanentFailure).not.toHaveBeenCalled();
    expect(sched.last?.ms).toBe(3_000); // honours server Retry-After
  });

  it("RETAINS the batch on a 5xx (server error — retryable)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonError(500, "internal_server_error")) as unknown as typeof fetch;
    const sched = captureScheduler();
    const onPermanentFailure = vi.fn();
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 1,
      intervalMs: 10_000,
      envelope,
      scheduler: sched.scheduler,
      onPermanentFailure,
    });
    q.enqueue(makeEvent("a"));
    await q.flush();
    expect(onPermanentFailure).not.toHaveBeenCalled();
    expect(sched.callCount).toBe(1);
    expect(q.getStats().inFlight).toBe(1);
  });

  it("RETAINS the batch on a network error (no status — retryable)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    const onPermanentFailure = vi.fn();
    // batchSize=2 so a single enqueue does NOT auto-fire flush. The
    // captured scheduler sees BOTH idle-flush + retry calls, so we
    // can't compare callCount cleanly — assert via `nextRetryAt`
    // (canonical "retry scheduled" signal, set ONLY by the retry
    // path) instead. Same pattern as the 401 permanent-failure test
    // above.
    const q = new EventQueue({
      http: makeHttp(),
      batchSize: 2,
      intervalMs: 10_000,
      envelope,
      scheduler: () => () => {},
      onPermanentFailure,
    });
    q.enqueue(makeEvent("a"));
    await q.flush();
    expect(onPermanentFailure).not.toHaveBeenCalled();
    expect(q.getStats().nextRetryAt).not.toBeNull();
    expect(q.getStats().consecutiveFailures).toBe(1);
    expect(q.getStats().inFlight).toBe(1);
  });
});
