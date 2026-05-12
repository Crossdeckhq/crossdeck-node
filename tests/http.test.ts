import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CrossdeckError } from "../src/errors";
import { DEFAULT_BASE_URL, HttpClient } from "../src/http";

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
});
