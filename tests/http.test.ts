import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CrossdeckError, CrossdeckNetworkError } from "../src/errors";
import { CROSSDECK_API_VERSION, DEFAULT_BASE_URL, HttpClient } from "../src/http";

describe("HttpClient", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function client() {
    return new HttpClient({
      secretKey: "cd_sk_test_001",
      baseUrl: DEFAULT_BASE_URL,
      sdkVersion: "0.1.0-test",
    });
  }

  function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  }

  it("attaches Authorization: Bearer + Crossdeck-Sdk-Version + Accept headers", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await client().request("GET", "/entitlements", { query: { userId: "u1" } });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init.headers["Authorization"]).toBe("Bearer cd_sk_test_001");
    expect(init.headers["Crossdeck-Sdk-Version"]).toContain("@cross-deck/node@0.1.0-test");
    expect(init.headers["Accept"]).toBe("application/json");
  });

  it("appends query parameters with proper URL encoding", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await client().request("GET", "/entitlements", {
      query: { userId: "user 847", anonymousId: undefined, customerId: "cdcust_x" },
    });

    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("userId=user+847");
    expect(url).toContain("customerId=cdcust_x");
    expect(url).not.toContain("anonymousId=");
  });

  it("serialises POST body and sets Content-Type", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(202, { received: 1 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await client().request("POST", "/events", {
      body: { events: [{ name: "click" }] },
    });

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ events: [{ name: "click" }] });
  });

  it("sanitises a raw body with BigInt, Error, Map, Set, and circular refs as defence in depth", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(202, { received: 1 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cycle: Record<string, unknown> = { name: "cycle" };
    cycle.self = cycle;

    await client().request("POST", "/events", {
      body: {
        big: 1n,
        err: new Error("boom"),
        map: new Map([["a", 1]]),
        set: new Set([1, 2]),
        cycle,
      },
    });

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({
      big: "1",
      err: expect.objectContaining({ name: "Error", message: "boom" }),
      map: { a: 1 },
      set: [1, 2],
      cycle: { name: "cycle", self: "[circular]" },
    });
  });

  it("throws a typed CrossdeckError on a Stripe-style 4xx", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(401, {
        error: {
          type: "authentication_error",
          code: "invalid_api_key",
          message: "bad key",
          request_id: "req_xyz",
        },
      }),
    ) as unknown as typeof fetch;

    await expect(client().request("GET", "/entitlements")).rejects.toMatchObject({
      type: "authentication_error",
      code: "invalid_api_key",
      requestId: "req_xyz",
      status: 401,
    });
  });

  it("wraps fetch network failures as CrossdeckError(type: network_error)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch;

    await expect(client().request("GET", "/entitlements")).rejects.toMatchObject({
      type: "network_error",
      code: "fetch_failed",
    });
  });

  it("attaches Idempotency-Key when requested", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await client().request("POST", "/events", {
      body: { events: [] },
      idempotencyKey: "batch_abc123",
    });

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init.headers["Idempotency-Key"]).toBe("batch_abc123");
  });

  it("aborts the fetch after timeoutMs and surfaces request_timeout", async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal as AbortSignal;
        signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const c = new HttpClient({
      secretKey: "cd_sk_test_001",
      baseUrl: DEFAULT_BASE_URL,
      sdkVersion: "0.1.0-test",
      timeoutMs: 30,
    });

    await expect(c.request("GET", "/entitlements")).rejects.toMatchObject({
      type: "network_error",
      code: "request_timeout",
    });
  });

  it("throws internal_error if a 2xx returns unparseable JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("not json{{", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    try {
      await client().request("GET", "/entitlements");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CrossdeckError);
      expect((err as CrossdeckError).code).toBe("invalid_json_response");
    }
  });

  it("throws CrossdeckError(serialization_failed) when a request body cannot be sanitized", async () => {
    const broken: Record<string, unknown> = {};
    Object.defineProperty(broken, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });

    await expect(
      client().request("POST", "/events", {
        body: broken,
      }),
    ).rejects.toMatchObject({
      type: "invalid_request_error",
      code: "serialization_failed",
    });
  });

  it("sends Crossdeck-Api-Version + User-Agent headers on every request", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await client().request("GET", "/entitlements", { query: { userId: "u" } });
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init.headers["Crossdeck-Api-Version"]).toBe(CROSSDECK_API_VERSION);
    expect(init.headers["User-Agent"]).toMatch(/^@cross-deck\/node\/[^ ]+ /);
    expect(init.headers["User-Agent"]).toContain("node/");
  });

  it("idempotent GET retries on transient 503 — final attempt succeeds", async () => {
    let calls = 0;
    const fetchSpy = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1)
        return Promise.resolve(jsonResponse(503, { error: { type: "internal_error", code: "x", message: "down" } }));
      if (calls === 2)
        return Promise.resolve(jsonResponse(503, { error: { type: "internal_error", code: "x", message: "down" } }));
      return Promise.resolve(jsonResponse(200, { ok: true }));
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const c = new HttpClient({
      secretKey: "cd_sk_test_001",
      baseUrl: DEFAULT_BASE_URL,
      sdkVersion: "0.1.0-test",
      httpRetries: { maxAttempts: 3 },
    });
    const result = await c.request<{ ok: boolean }>("GET", "/sdk/heartbeat");
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("GET retry — exhausted attempts throw the typed subclass (CrossdeckInternalError for 5xx)", async () => {
    // Each call returns a FRESH Response — Response bodies are
    // one-shot read streams, so reusing the same instance across
    // retries falls through to the http_<status> fallback.
    const fetchSpy = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse(503, { error: { type: "internal_error", code: "down", message: "down" } }),
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const c = new HttpClient({
      secretKey: "cd_sk_test_001",
      baseUrl: DEFAULT_BASE_URL,
      sdkVersion: "0.1.0-test",
      httpRetries: { maxAttempts: 2 },
    });
    await expect(c.request("GET", "/sdk/heartbeat")).rejects.toMatchObject({ code: "down" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("POST does NOT auto-retry (POST retries are queue-driven, not HTTP-driven)", async () => {
    const fetchSpy = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse(503, { error: { type: "internal_error", code: "x", message: "x" } }),
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const c = new HttpClient({
      secretKey: "cd_sk_test_001",
      baseUrl: DEFAULT_BASE_URL,
      sdkVersion: "0.1.0-test",
      httpRetries: { maxAttempts: 3 },
    });
    await expect(c.request("POST", "/events", { body: {} })).rejects.toBeInstanceOf(CrossdeckError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("testMode short-circuits — no fetch goes out, synthetic response shape comes back", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const c = new HttpClient({
      secretKey: "cd_sk_test_001",
      baseUrl: DEFAULT_BASE_URL,
      sdkVersion: "0.1.0-test",
      testMode: true,
    });
    const heartbeat = await c.request<{ ok: boolean; projectId: string }>("GET", "/sdk/heartbeat");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(heartbeat.ok).toBe(true);
    expect(heartbeat.projectId).toBe("proj_test_mode");
  });

  it("onRequest / onResponse hooks fire on every attempt with the right shape", async () => {
    let calls = 0;
    const fetchSpy = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1)
        return Promise.resolve(jsonResponse(503, { error: { type: "internal_error", code: "x", message: "x" } }));
      return Promise.resolve(jsonResponse(200, { ok: true }));
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const reqEvents: Array<{ attempt: number; method: string }> = [];
    const resEvents: Array<{ attempt: number; status: number; testMode: boolean }> = [];
    const c = new HttpClient({
      secretKey: "cd_sk_test_001",
      baseUrl: DEFAULT_BASE_URL,
      sdkVersion: "0.1.0-test",
      httpRetries: { maxAttempts: 2 },
      onRequest: (info) => reqEvents.push({ attempt: info.attempt, method: info.method }),
      onResponse: (info) => resEvents.push({ attempt: info.attempt, status: info.status, testMode: info.testMode }),
    });
    await c.request("GET", "/sdk/heartbeat");

    expect(reqEvents).toEqual([
      { attempt: 1, method: "GET" },
      { attempt: 2, method: "GET" },
    ]);
    expect(resEvents).toHaveLength(2);
    expect(resEvents[0]!.status).toBe(503);
    expect(resEvents[1]!.status).toBe(200);
    expect(resEvents[0]!.testMode).toBe(false);
  });

  it("AbortSignal — caller-supplied abort cancels the in-flight request as request_aborted", async () => {
    // Mock fetch that honours the signal (real fetch does this; our
    // mock has to mimic it so the test exercises the abort path).
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => {
          const err: Error & { name?: string } = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (init?.signal?.aborted) {
          onAbort();
          return;
        }
        init?.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }) as unknown as typeof fetch;

    const c = new HttpClient({
      secretKey: "cd_sk_test_001",
      baseUrl: DEFAULT_BASE_URL,
      sdkVersion: "0.1.0-test",
      timeoutMs: 0,
    });
    const ctrl = new AbortController();
    const flight = c.request("GET", "/sdk/heartbeat", {
      signal: ctrl.signal,
      // Disable retries — we want the abort to surface immediately,
      // not after the retry loop exhausts.
      retries: { maxAttempts: 1 },
    });
    setTimeout(() => ctrl.abort(), 20);
    try {
      await flight;
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CrossdeckNetworkError);
      expect((err as CrossdeckError).code).toBe("request_aborted");
    }
  });
});
