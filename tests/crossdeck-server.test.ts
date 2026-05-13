import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CrossdeckError } from "../src/errors";
import { CrossdeckServer } from "../src/index";

describe("CrossdeckServer", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Standard test helper. Opts out of lifecycle side effects — every
   * test creates a fresh server, and installing `process.on(...)`
   * handlers for each would pile up across the suite and trip Node's
   * 10-listener warning.
   */
  function server(): CrossdeckServer {
    return new CrossdeckServer({
      secretKey: "cd_sk_test_001",
      appId: "app_web_123",
      sdkVersion: "0.1.0-test",
      errorCapture: false,
      flushOnExit: false,
    });
  }

  function serverWithoutAppId(): CrossdeckServer {
    return new CrossdeckServer({
      secretKey: "cd_sk_test_001",
      baseUrl: "https://edge.cross-deck.test/v1",
      timeoutMs: 0,
      sdkVersion: "0.1.0-test",
      errorCapture: false,
      flushOnExit: false,
    });
  }

  /**
   * Server with the error tracker constructed but ALL its global hooks
   * disabled — `captureError` + `captureMessage` work via direct method
   * calls without needing `process.on(...)` listeners. Tests using this
   * helper should always call `s.shutdown()` in a `finally` block for
   * defence in depth.
   */
  function serverWithCapture(): CrossdeckServer {
    return new CrossdeckServer({
      secretKey: "cd_sk_test_001",
      appId: "app_web_123",
      sdkVersion: "0.1.0-test",
      flushOnExit: false,
      errorCapture: {
        onUncaughtException: false,
        onUnhandledRejection: false,
        wrapFetch: false,
        captureConsole: false,
      },
    });
  }

  // ============================================================
  // Construction
  // ============================================================

  it("rejects non-secret keys at construction time", () => {
    expect(
      () =>
        new CrossdeckServer({
          secretKey: "cd_pub_test_001",
          errorCapture: false,
          flushOnExit: false,
        }),
    ).toThrowError(CrossdeckError);
  });

  // ============================================================
  // identify / aliasIdentity — direct HTTP
  // ============================================================

  it("identify() posts to /identity/alias", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        object: "alias_result",
        crossdeckCustomerId: "cdcust_123",
        linked: [],
        mergePending: false,
        env: "sandbox",
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await server().identify("user_1", "anon_1", { email: "a@example.com" });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("/identity/alias");
    expect(JSON.parse(init.body as string)).toEqual({
      userId: "user_1",
      anonymousId: "anon_1",
      email: "a@example.com",
    });
  });

  it("identify() sanitises traits with the same rules as the web SDK", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        object: "alias_result",
        crossdeckCustomerId: "cdcust_123",
        linked: [],
        mergePending: false,
        env: "sandbox",
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cycle: Record<string, unknown> = { name: "cycle" };
    cycle.self = cycle;

    await server().identify("user_1", "anon_1", {
      traits: {
        big: 1n,
        err: new Error("boom"),
        map: new Map([["a", 1]]),
        set: new Set([1, 2]),
        cycle,
      },
    });

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({
      userId: "user_1",
      anonymousId: "anon_1",
      traits: {
        big: "1",
        err: expect.objectContaining({ name: "Error", message: "boom" }),
        map: { a: 1 },
        set: [1, 2],
        cycle: { name: "cycle", self: "[circular]" },
      },
    });
  });

  it("aliasIdentity() rejects a missing userId", async () => {
    await expect(
      server().aliasIdentity({ anonymousId: "anon_1" } as never),
    ).rejects.toMatchObject({
      code: "missing_user_id",
    });
  });

  it("aliasIdentity() rejects a missing anonymousId", async () => {
    await expect(
      server().aliasIdentity({ userId: "user_1" } as never),
    ).rejects.toMatchObject({
      code: "missing_anonymous_id",
    });
  });

  // ============================================================
  // Entitlements — direct HTTP (TTL cache lands in USP 3)
  // ============================================================

  it("getEntitlements() sends the identity query", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        object: "list",
        data: [],
        crossdeckCustomerId: "cdcust_123",
        env: "sandbox",
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await server().getEntitlements({ userId: "user_1" });

    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("/entitlements");
    expect(url).toContain("userId=user_1");
  });

  it("forget() rejects when no identity hints are provided", async () => {
    await expect(server().forget({})).rejects.toMatchObject({
      code: "missing_identity",
    });
  });

  it("getEntitlements() rejects when no identity hints are provided", async () => {
    await expect(server().getEntitlements({})).rejects.toMatchObject({
      code: "missing_identity",
    });
  });

  it("getCustomerEntitlements() uses the server route", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        object: "list",
        data: [],
        crossdeckCustomerId: "cdcust_123",
        env: "sandbox",
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await server().getCustomerEntitlements("cdcust_123");

    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("/server/customers/cdcust_123/entitlements");
  });

  it("getCustomerEntitlements() rejects a missing customerId", async () => {
    await expect(server().getCustomerEntitlements("")).rejects.toMatchObject({
      code: "missing_customer_id",
    });
  });

  // ============================================================
  // ingest() — immediate POST (bulk import path)
  // ============================================================

  it("ingest() stamps sdk metadata and auto-mints event IDs", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await server().ingest([
      {
        name: "checkout.started",
        developerUserId: "user_1",
      },
    ]);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("/events");
    const body = JSON.parse(init.body as string);
    expect(body.appId).toBe("app_web_123");
    expect(body.sdk).toEqual({ name: "@cross-deck/node", version: "0.1.0-test" });
    expect(body.events[0].eventId).toMatch(/^evt_/);
    expect(body.events[0].timestamp).toEqual(expect.any(Number));
  });

  it("ingest() sanitises event properties before sending", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cycle: Record<string, unknown> = { name: "cycle" };
    cycle.self = cycle;

    await server().ingest([
      {
        name: "checkout.started",
        developerUserId: "user_1",
        properties: {
          big: 1n,
          err: new Error("boom"),
          map: new Map([["a", 1]]),
          set: new Set([1, 2]),
          cycle,
        },
      },
    ]);

    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.events[0].properties).toEqual({
      big: "1",
      err: expect.objectContaining({ name: "Error", message: "boom" }),
      map: { a: 1 },
      set: [1, 2],
      cycle: { name: "cycle", self: "[circular]" },
    });
  });

  it("ingest() rejects an empty batch", async () => {
    await expect(server().ingest([])).rejects.toMatchObject({
      code: "missing_events",
    });
  });

  it("ingest() rejects events with a missing name before sending", async () => {
    await expect(
      server().ingest([
        {
          developerUserId: "user_1",
        } as never,
      ]),
    ).rejects.toMatchObject({
      code: "missing_event_name",
    });
  });

  it("ingest() preserves caller event metadata, supports custom idempotency, and omits appId when unset", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await serverWithoutAppId().ingest(
      [
        {
          eventId: "evt_fixed",
          timestamp: 1_717_891_200_000,
          name: "job.completed",
          crossdeckCustomerId: "cdcust_123",
        },
      ],
      { idempotencyKey: "batch_fixed" },
    );

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("https://edge.cross-deck.test/v1/events");
    expect(init.signal).toBeUndefined();
    expect(init.headers["Idempotency-Key"]).toBe("batch_fixed");
    const body = JSON.parse(init.body as string);
    expect(body.appId).toBeUndefined();
    expect(body.events[0]).toMatchObject({
      eventId: "evt_fixed",
      timestamp: 1_717_891_200_000,
      name: "job.completed",
      crossdeckCustomerId: "cdcust_123",
    });
  });

  it("ingest() rejects events with no identity hint (strict mode for bulk imports)", async () => {
    await expect(server().ingest([{ name: "checkout.started" }])).rejects.toMatchObject({
      code: "missing_identity",
    });
  });

  // ============================================================
  // track() — enqueue + batched flush (v1.0.0 behaviour, parity with web)
  // ============================================================

  it("track() throws CrossdeckError with code 'missing_event_name' when event name is empty", () => {
    expect(() => server().track({ name: "" })).toThrowError(CrossdeckError);
    try {
      server().track({ name: "" });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as CrossdeckError).code).toBe("missing_event_name");
    }
  });

  it("track() auto-fills anonymousId with the SDK process identity when no identity hint is supplied", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = server();
    s.track({ name: "checkout.started" });
    await s.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].name).toBe("checkout.started");
    expect(body.events[0].anonymousId).toMatch(/^anon_node_/);
  });

  it("track() respects caller-supplied identity over the auto-fill", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = server();
    s.track({ name: "checkout.started", developerUserId: "user_42" });
    await s.flush();

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.events[0].developerUserId).toBe("user_42");
    expect(body.events[0].anonymousId).toBeUndefined();
  });

  it("track() enqueues — no HTTP until flush() is awaited", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = server();
    s.track({ name: "checkout.started", developerUserId: "user_1" });
    expect(fetchSpy).not.toHaveBeenCalled();

    await s.flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("track() auto-attaches runtime info (runtime.*) to event properties", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = server();
    s.track({ name: "checkout.started", developerUserId: "user_1" });
    await s.flush();

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.events[0].properties["runtime.nodeVersion"]).toBe(process.versions.node);
    expect(body.events[0].properties["runtime.host"]).toBeDefined();
    expect(body.events[0].properties["runtime.platform"]).toBeDefined();
  });

  it("track() respects caller-supplied properties over runtime defaults on key collision", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = server();
    s.track({
      name: "checkout.started",
      developerUserId: "user_1",
      properties: { "runtime.region": "override-region" },
    });
    await s.flush();

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.events[0].properties["runtime.region"]).toBe("override-region");
  });

  // ============================================================
  // flush() — drain the queue
  // ============================================================

  it("flush() sends a batched POST to /events with Idempotency-Key: batch_…", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 2, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = server();
    s.track({ name: "a", developerUserId: "user_1" });
    s.track({ name: "b", developerUserId: "user_1" });
    await s.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("/events");
    expect(init.headers["Idempotency-Key"]).toMatch(/^batch_/);
    const body = JSON.parse(init.body as string);
    expect(body.events.map((e: { name: string }) => e.name)).toEqual(["a", "b"]);
  });

  it("flush() is a no-op when the queue is empty", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await server().flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ============================================================
  // captureError + captureMessage
  // ============================================================

  it("captureError(new Error()) ships an error.handled event with parsed frames + fingerprint", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = serverWithCapture();
    try {
      s.captureError(new Error("boom"));
      await s.flush();
    } finally {
      s.shutdown();
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    const errEvent = body.events[0];
    expect(errEvent.name).toBe("error.handled");
    expect(errEvent.properties.message).toBe("boom");
    expect(errEvent.properties.errorType).toBe("Error");
    expect(errEvent.properties.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(Array.isArray(errEvent.properties.frames)).toBe(true);
    expect(errEvent.properties.frames.length).toBeGreaterThan(0);
  });

  it("captureError(<non-Error>) coerces and ships error.handled", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = serverWithCapture();
    try {
      s.captureError("a string thrown by accident");
      await s.flush();
    } finally {
      s.shutdown();
    }

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.events[0].properties.message).toBe("a string thrown by accident");
    expect(body.events[0].properties.errorType).toBeNull();
  });

  it("captureError merges options.context and options.tags into the event", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = serverWithCapture();
    try {
      s.captureError(new Error("boom"), {
        context: { jobId: "job_42" },
        tags: { flow: "checkout" },
      });
      await s.flush();
    } finally {
      s.shutdown();
    }

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.events[0].properties.context.jobId).toBe("job_42");
    expect(body.events[0].properties.tags.flow).toBe("checkout");
  });

  it("captureMessage('hi', 'warning') ships an error.message event", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = serverWithCapture();
    try {
      s.captureMessage("deprecated path hit", "warning");
      await s.flush();
    } finally {
      s.shutdown();
    }

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.events[0].name).toBe("error.message");
    expect(body.events[0].properties.message).toBe("deprecated path hit");
    expect(body.events[0].properties.level).toBe("warning");
  });

  it("captureError is a no-op when errorCapture: false at construction", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = server(); // errorCapture: false
    s.captureError(new Error("ignored"));
    await s.flush();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ============================================================
  // setTag / setTags / setContext / addBreadcrumb
  // ============================================================

  it("setTag attaches the tag to subsequent error reports", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = serverWithCapture();
    try {
      s.setTag("release", "v1.0.0");
      s.captureError(new Error("boom"));
      await s.flush();
    } finally {
      s.shutdown();
    }

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.events[0].properties.tags.release).toBe("v1.0.0");
  });

  it("setTags merges multiple tags additively", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = serverWithCapture();
    try {
      s.setTags({ a: "1", b: "2" });
      s.setTag("c", "3");
      s.captureError(new Error("boom"));
      await s.flush();
    } finally {
      s.shutdown();
    }

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.events[0].properties.tags).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("setContext attaches structured data to subsequent error reports", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = serverWithCapture();
    try {
      s.setContext("request", { method: "POST", path: "/checkout" });
      s.captureError(new Error("boom"));
      await s.flush();
    } finally {
      s.shutdown();
    }

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.events[0].properties.context.request).toEqual({ method: "POST", path: "/checkout" });
  });

  it("addBreadcrumb attaches the crumb to subsequent error reports", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = serverWithCapture();
    try {
      s.addBreadcrumb({
        timestamp: Date.now(),
        category: "custom",
        message: "user-opened-paywall",
      });
      s.captureError(new Error("boom"));
      await s.flush();
    } finally {
      s.shutdown();
    }

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.events[0].properties.breadcrumbs.length).toBeGreaterThan(0);
    expect(
      body.events[0].properties.breadcrumbs.some(
        (c: { message?: string }) => c.message === "user-opened-paywall",
      ),
    ).toBe(true);
  });

  it("track() events are auto-added to the breadcrumb buffer", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 2, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = serverWithCapture();
    try {
      s.track({ name: "paywall_shown", developerUserId: "user_1" });
      s.captureError(new Error("boom"));
      await s.flush();
    } finally {
      s.shutdown();
    }

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    const errEvent = body.events.find((e: { name: string }) => e.name === "error.handled");
    expect(errEvent).toBeDefined();
    expect(
      errEvent.properties.breadcrumbs.some(
        (c: { message?: string }) => c.message === "paywall_shown",
      ),
    ).toBe(true);
  });

  it("error.* events do NOT add a breadcrumb (would cause a cycle)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 2, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = serverWithCapture();
    try {
      s.captureError(new Error("first"));
      s.captureError(new Error("second"));
      await s.flush();
    } finally {
      s.shutdown();
    }

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    const second = body.events.find(
      (e: { properties: { message?: string } }) => e.properties.message === "second",
    );
    // The second error's breadcrumb buffer should NOT contain the first
    // error as a crumb — that's the no-error-breadcrumb invariant.
    const hasFirstAsCrumb = second.properties.breadcrumbs.some(
      (c: { message?: string }) => c.message?.startsWith("error."),
    );
    expect(hasFirstAsCrumb).toBe(false);
  });

  // ============================================================
  // setErrorBeforeSend
  // ============================================================

  it("setErrorBeforeSend(() => null) drops the report — no HTTP fires", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = serverWithCapture();
    try {
      s.setErrorBeforeSend(() => null);
      s.captureError(new Error("boom"));
      await s.flush();
    } finally {
      s.shutdown();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("setErrorBeforeSend returning a modified CapturedError ships the modified version", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = serverWithCapture();
    try {
      s.setErrorBeforeSend((err) => ({
        ...err,
        message: "[scrubbed]",
        context: { ...err.context, redacted: true },
      }));
      s.captureError(new Error("auth-token-12345"));
      await s.flush();
    } finally {
      s.shutdown();
    }

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.events[0].properties.message).toBe("[scrubbed]");
    expect(body.events[0].properties.context.redacted).toBe(true);
  });

  it("a throwing setErrorBeforeSend falls back to the original report (never swallows)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = serverWithCapture();
    try {
      s.setErrorBeforeSend(() => {
        throw new Error("hook crashed");
      });
      s.captureError(new Error("original"));
      await s.flush();
    } finally {
      s.shutdown();
    }

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.events[0].properties.message).toBe("original");
  });

  // ============================================================
  // syncPurchases / grantEntitlement / revokeEntitlement / getAuditEntry
  // ============================================================

  it("syncPurchases() rejects when signedTransactionInfo is missing", async () => {
    await expect(
      server().syncPurchases({ rail: "apple", signedTransactionInfo: "" }),
    ).rejects.toMatchObject({
      code: "missing_signed_transaction_info",
    });
  });

  it("syncPurchases() defaults the rail to apple", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        object: "purchase_result",
        crossdeckCustomerId: "cdcust_123",
        env: "sandbox",
        entitlements: [],
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await server().syncPurchases({
      signedTransactionInfo: "signed_txn",
      signedRenewalInfo: "signed_renewal",
    });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("/purchases/sync");
    expect(JSON.parse(init.body as string)).toEqual({
      rail: "apple",
      signedTransactionInfo: "signed_txn",
      signedRenewalInfo: "signed_renewal",
    });
  });

  it("grantEntitlement() posts to the server grant route", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        object: "entitlement_mutation",
        action: "grant",
        crossdeckCustomerId: "cdcust_123",
        entitlement: {
          object: "entitlement",
          key: "pro",
          isActive: true,
          validUntil: null,
          source: { rail: "manual", productId: "manual", subscriptionId: "manual:server_api" },
          updatedAt: 1717891200,
        },
        env: "sandbox",
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await server().grantEntitlement({
      customerId: "cdcust_123",
      entitlementKey: "pro",
      duration: "lifetime",
      reason: "Support override",
    });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("/server/customers/cdcust_123/grant");
    expect(JSON.parse(init.body as string)).toEqual({
      entitlementKey: "pro",
      duration: "lifetime",
      reason: "Support override",
    });
  });

  it("grantEntitlement() rejects a missing customerId", async () => {
    await expect(
      server().grantEntitlement({
        customerId: "",
        entitlementKey: "pro",
        duration: "lifetime",
        reason: "Support override",
      }),
    ).rejects.toMatchObject({
      code: "missing_customer_id",
    });
  });

  it("revokeEntitlement() posts to the server revoke route", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        object: "entitlement_mutation",
        action: "revoke",
        crossdeckCustomerId: "cdcust_123",
        entitlement: {
          object: "entitlement",
          key: "pro",
          isActive: false,
          validUntil: null,
          source: { rail: "manual", productId: "manual", subscriptionId: "manual:server_api" },
          updatedAt: 1717891200,
        },
        env: "sandbox",
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await server().revokeEntitlement({
      customerId: "cdcust_123",
      entitlementKey: "pro",
      reason: "Chargeback",
    });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("/server/customers/cdcust_123/revoke");
    expect(JSON.parse(init.body as string)).toEqual({
      entitlementKey: "pro",
      reason: "Chargeback",
    });
  });

  it("revokeEntitlement() rejects a missing customerId", async () => {
    await expect(
      server().revokeEntitlement({
        customerId: "",
        entitlementKey: "pro",
        reason: "Chargeback",
      }),
    ).rejects.toMatchObject({
      code: "missing_customer_id",
    });
  });

  it("getAuditEntry() unwraps the response envelope", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        object: "audit_entry",
        data: {
          eventId: "audit_123",
          rail: "manual",
          env: "sandbox",
          eventType: "entitlement.granted_manually",
          projectId: "proj_123",
          decision: "applied",
          signatureVerified: true,
          reconciledWithProvider: false,
          rawEventReceivedAt: 1,
          processedAt: 2,
        },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await server().getAuditEntry("audit_123");
    expect(result.eventId).toBe("audit_123");
  });

  it("getAuditEntry() rejects a missing eventId", async () => {
    await expect(server().getAuditEntry("")).rejects.toMatchObject({
      code: "missing_event_id",
    });
  });

  // ============================================================
  // diagnostics()
  // ============================================================

  it("diagnostics() returns a stable shape with runtime + events + errors fields", () => {
    const d = server().diagnostics();

    expect(d.sdkVersion).toBe("0.1.0-test");
    expect(d.baseUrl).toBe("https://api.cross-deck.com/v1");
    expect(d.secretKeyPrefix.startsWith("cd_sk_test_")).toBe(true);
    expect(d.env).toBe("sandbox");
    expect(d.runtime.nodeVersion).toBe(process.versions.node);
    expect(d.runtime.platform).toBeDefined();
    expect(d.events).toMatchObject({
      buffered: 0,
      dropped: 0,
      inFlight: 0,
      consecutiveFailures: 0,
    });
    expect(d.errors).toMatchObject({ sessionCount: 0, fingerprintsTracked: 0 });
  });

  it("diagnostics().env reflects cd_sk_live_ secret keys as 'production'", () => {
    const s = new CrossdeckServer({
      secretKey: "cd_sk_live_001",
      sdkVersion: "0.1.0-test",
      errorCapture: false,
      flushOnExit: false,
    });
    expect(s.diagnostics().env).toBe("production");
  });

  it("diagnostics().events.buffered reflects queued events before flush", () => {
    const s = server();
    s.track({ name: "a", developerUserId: "u" });
    s.track({ name: "b", developerUserId: "u" });
    expect(s.diagnostics().events.buffered).toBe(2);
  });

  it("diagnostics().errors.handlersInstalled is true when errorCapture installed global hooks", () => {
    const s = new CrossdeckServer({
      secretKey: "cd_sk_test_001",
      sdkVersion: "0.1.0-test",
      flushOnExit: false,
      // errorCapture defaults to true → handlers install
    });
    try {
      expect(s.diagnostics().errors.handlersInstalled).toBe(true);
    } finally {
      s.shutdown();
    }
  });

  it("diagnostics().errors.handlersInstalled is false when errorCapture is disabled", () => {
    expect(server().diagnostics().errors.handlersInstalled).toBe(false);
  });

  // ============================================================
  // USP 2 — Super-properties + groups (v1.0.0)
  // ============================================================

  it("register() adds super-properties that auto-attach to every subsequent event", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = server();
    s.register({ tenant: "acme", plan: "pro" });
    s.track({ name: "paywall_shown", developerUserId: "user_1" });
    await s.flush();

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.events[0].properties.tenant).toBe("acme");
    expect(body.events[0].properties.plan).toBe("pro");
  });

  it("register({ x: null }) deletes the super-property (Mixpanel idiom)", () => {
    const s = server();
    s.register({ plan: "pro" });
    expect(s.getSuperProperties()).toEqual({ plan: "pro" });
    s.register({ plan: null });
    expect(s.getSuperProperties()).toEqual({});
  });

  it("unregister(key) removes a single super-property", () => {
    const s = server();
    s.register({ a: 1, b: 2 });
    s.unregister("a");
    expect(s.getSuperProperties()).toEqual({ b: 2 });
  });

  it("caller-supplied properties override super-properties on key collision", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = server();
    s.register({ plan: "free" });
    s.track({
      name: "paywall_shown",
      developerUserId: "user_1",
      properties: { plan: "pro" },
    });
    await s.flush();

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.events[0].properties.plan).toBe("pro");
  });

  it("group(type, id) attaches $groups.<type> to every event", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = server();
    s.group("org", "acme_inc");
    s.group("team", "design", { headcount: 12 });
    s.track({ name: "doc_viewed", developerUserId: "user_1" });
    await s.flush();

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
    expect(body.events[0].properties.$groups).toEqual({ org: "acme_inc", team: "design" });
  });

  it("group(type, null) clears the membership", () => {
    const s = server();
    s.group("org", "acme");
    expect(s.getGroups()).toEqual({ org: { id: "acme" } });
    s.group("org", null);
    expect(s.getGroups()).toEqual({});
  });

  it("group() throws CrossdeckError on missing type", () => {
    expect(() => server().group("", "x")).toThrowError(CrossdeckError);
  });

  // ============================================================
  // USP 3 — Entitlement cache (TTL + hint resolution)
  // ============================================================

  it("getEntitlements() populates the cache and aliases userId → crossdeckCustomerId", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        object: "list",
        data: [
          {
            object: "entitlement",
            key: "pro",
            isActive: true,
            validUntil: null,
            source: { rail: "manual", productId: "p", subscriptionId: "s" },
            updatedAt: 1,
          },
        ],
        crossdeckCustomerId: "cdcust_abc",
        env: "sandbox",
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = server();
    await s.getEntitlements({ userId: "user_1" });

    // Lookup by canonical customerId works
    expect(s.isEntitled({ customerId: "cdcust_abc" }, "pro")).toBe(true);
    // Lookup by aliased userId also works
    expect(s.isEntitled({ userId: "user_1" }, "pro")).toBe(true);
    // Lookup for an unknown key returns false
    expect(s.isEntitled({ userId: "user_1" }, "team")).toBe(false);
  });

  it("isEntitled(string, key) treats the string as a canonical customerId", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        object: "list",
        data: [
          {
            object: "entitlement",
            key: "pro",
            isActive: true,
            validUntil: null,
            source: { rail: "manual", productId: "p", subscriptionId: "s" },
            updatedAt: 1,
          },
        ],
        crossdeckCustomerId: "cdcust_abc",
        env: "sandbox",
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = server();
    await s.getEntitlements({ customerId: "cdcust_abc" });
    expect(s.isEntitled("cdcust_abc", "pro")).toBe(true);
  });

  it("listEntitlements(hint) returns the cached entitlement list", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        object: "list",
        data: [
          {
            object: "entitlement",
            key: "pro",
            isActive: true,
            validUntil: null,
            source: { rail: "manual", productId: "p", subscriptionId: "s" },
            updatedAt: 1,
          },
        ],
        crossdeckCustomerId: "cdcust_abc",
        env: "sandbox",
      }),
    ) as unknown as typeof fetch;

    const s = server();
    await s.getEntitlements({ userId: "user_1" });
    const list = s.listEntitlements({ userId: "user_1" });
    expect(list).toHaveLength(1);
    expect(list[0]!.key).toBe("pro");
  });

  it("isEntitled returns false when the cache is cold (no prior getEntitlements)", () => {
    expect(server().isEntitled({ userId: "user_1" }, "pro")).toBe(false);
  });

  it("onEntitlementsChange listener fires after getEntitlements populates the cache", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        object: "list",
        data: [],
        crossdeckCustomerId: "cdcust_abc",
        env: "sandbox",
      }),
    ) as unknown as typeof fetch;

    const s = server();
    const calls: string[] = [];
    s.onEntitlementsChange((customerId) => calls.push(customerId));
    await s.getEntitlements({ userId: "user_1" });
    expect(calls).toEqual(["cdcust_abc"]);
  });

  it("diagnostics().entitlements reflects real cache state after getEntitlements", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        object: "list",
        data: [],
        crossdeckCustomerId: "cdcust_abc",
        env: "sandbox",
      }),
    ) as unknown as typeof fetch;

    const s = server();
    expect(s.diagnostics().entitlements.count).toBe(0);
    await s.getEntitlements({ userId: "user_1" });
    expect(s.diagnostics().entitlements.count).toBe(1);
    expect(s.diagnostics().entitlements.ttlMs).toBe(60_000);
    expect(s.diagnostics().entitlements.lastUpdated).toBeGreaterThan(0);
  });

  it("entitlementCacheTtlMs option configures the cache TTL", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        object: "list",
        data: [],
        crossdeckCustomerId: "cdcust_abc",
        env: "sandbox",
      }),
    ) as unknown as typeof fetch;

    const s = new CrossdeckServer({
      secretKey: "cd_sk_test_001",
      sdkVersion: "0.1.0-test",
      errorCapture: false,
      flushOnExit: false,
      entitlementCacheTtlMs: 5000,
    });
    expect(s.diagnostics().entitlements.ttlMs).toBe(5000);
  });

  // ============================================================
  // shutdown() — confirms clear of new USP 2 + 3 state
  // ============================================================

  it("diagnostics().secretKeyPrefix is masked (prefix + **** + last 4, never raw)", () => {
    // Test key fixture is `cd_sk_test_001` — 14 chars, prefix is 11 chars
    // (cd_sk_test_) so tail < 4 chars not exposed.
    expect(server().diagnostics().secretKeyPrefix).toBe("cd_sk_test_****");
  });

  it("diagnostics().secretKeyPrefix exposes the last 4 chars for longer keys", () => {
    const s = new CrossdeckServer({
      secretKey: "cd_sk_test_ABCDEFGHIJKLMN9999",
      sdkVersion: "0.1.0-test",
      errorCapture: false,
      flushOnExit: false,
    });
    expect(s.diagnostics().secretKeyPrefix).toBe("cd_sk_test_****9999");
    expect(s.diagnostics().secretKeyPrefix).not.toContain("ABCDEFGHIJKL");
  });

  it("heartbeat() calls GET /sdk/heartbeat and returns the HeartbeatResponse", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        object: "heartbeat",
        ok: true,
        projectId: "proj_x",
        appId: "app_x",
        platform: "node",
        env: "sandbox",
        serverTime: 1_700_000_000_000,
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await server().heartbeat();
    expect(result.projectId).toBe("proj_x");
    expect(result.appId).toBe("app_x");
    expect(result.env).toBe("sandbox");
    expect(result.serverTime).toBe(1_700_000_000_000);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("/sdk/heartbeat");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer cd_sk_test_001");
  });

  it("heartbeat() throws CrossdeckError on 401 (invalid secret)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: { type: "authentication_error", code: "invalid_secret_key", message: "key invalid" } },
        401,
      ),
    ) as unknown as typeof fetch;

    await expect(server().heartbeat()).rejects.toThrowError(CrossdeckError);
  });

  // ============================================================
  // QA review v2 — bank-grade SDK extras
  // ============================================================

  it("EventEmitter — server.on('queue.flush_failed') fires on retry-scheduled flush failure", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      attempts += 1;
      if (attempts === 1)
        return Promise.resolve(
          jsonResponse({ error: { type: "internal_error", code: "x", message: "x" } }, 500),
        );
      return Promise.resolve(jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202));
    }) as unknown as typeof fetch;

    const s = server();
    const events: Array<{ attempt: number; nextRetryMs: number }> = [];
    s.on("queue.flush_failed", (info) => events.push({ attempt: info.attempt, nextRetryMs: info.nextRetryMs }));
    s.track({ name: "x", developerUserId: "u" });
    await s.flush();
    expect(events).toHaveLength(1);
    expect(events[0]!.attempt).toBe(1);
  });

  it("EventEmitter — 'entitlements.warmed' fires once per getEntitlements", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        object: "list",
        data: [],
        crossdeckCustomerId: "cdcust_abc",
        env: "sandbox",
      }),
    ) as unknown as typeof fetch;

    const s = server();
    const events: Array<{ customerId: string; count: number }> = [];
    s.on("entitlements.warmed", (info) => events.push(info));
    await s.getEntitlements({ userId: "user_1" });
    expect(events).toEqual([{ customerId: "cdcust_abc", count: 0 }]);
  });

  it("EventEmitter — 'error.captured' fires when captureError is called", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = serverWithCapture();
    const events: Array<{ fingerprint: string; kind: string }> = [];
    s.on("error.captured", (info) => events.push({ fingerprint: info.fingerprint, kind: info.kind }));
    try {
      s.captureError(new Error("boom"));
      await s.flush();
    } finally {
      s.shutdown();
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("error.handled");
  });

  it("EventEmitter — 'sdk.shutdown' fires with reason on shutdown()", () => {
    const s = server();
    let reason: string | null = null;
    s.on("sdk.shutdown", (info) => {
      reason = info.reason;
    });
    s.shutdown();
    expect(reason).toBe("shutdown");
  });

  it("getHealth() returns ready=true on a fresh, healthy SDK", () => {
    const h = server().getHealth();
    expect(h.ready).toBe(true);
    expect(h.healthy).toBe(true);
    expect(h.bufferedEvents).toBe(0);
    expect(h.consecutiveFailures).toBe(0);
    expect(h.errorHandlersInstalled).toBe(false); // server() has errorCapture: false
  });

  it("getHealth() reflects errorHandlersInstalled when error capture is enabled", () => {
    const s = new CrossdeckServer({
      secretKey: "cd_sk_test_001",
      sdkVersion: "0.1.0-test",
      flushOnExit: false,
      // errorCapture defaults to true
    });
    try {
      expect(s.getHealth().errorHandlersInstalled).toBe(true);
    } finally {
      s.shutdown();
    }
  });

  it("isReady() flips false after sustained flush failures", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ error: { type: "internal_error", code: "x", message: "x" } }, 500),
    ) as unknown as typeof fetch;
    const s = server();
    expect(s.isReady()).toBe(true);
    // Five failures to push past the threshold (>=5 ⇒ not ready).
    for (let i = 0; i < 5; i++) {
      s.track({ name: "x", developerUserId: "u" });
      await s.flush();
    }
    expect(s.isReady()).toBe(false);
  });

  it("awaitReady(timeout) resolves false if the SDK never recovers", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ error: { type: "internal_error", code: "x", message: "x" } }, 500),
    ) as unknown as typeof fetch;
    const s = server();
    for (let i = 0; i < 5; i++) {
      s.track({ name: "x", developerUserId: "u" });
      await s.flush();
    }
    expect(s.isReady()).toBe(false);
    const ready = await s.awaitReady(100, 25);
    expect(ready).toBe(false);
  });

  it("[Symbol.dispose]() — sync disposal runs shutdown + fires sdk.shutdown with reason='dispose'", () => {
    const s = server();
    let reason: string | null = null;
    s.on("sdk.shutdown", (info) => {
      reason = info.reason;
    });
    s[Symbol.dispose]();
    expect(reason).toBe("dispose");
  });

  it("[Symbol.asyncDispose]() — async disposal awaits flush then shutdown", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = server();
    s.track({ name: "x", developerUserId: "u" });
    expect(s.diagnostics().events.buffered).toBe(1);
    await s[Symbol.asyncDispose]();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // flush fired
  });

  it("bulkGrantEntitlement — settled array, partial failures preserved", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 2) {
        return Promise.resolve(
          jsonResponse(
            { error: { type: "invalid_request_error", code: "missing_entitlement", message: "x" } },
            400,
          ),
        );
      }
      return Promise.resolve(
        jsonResponse({
          object: "entitlement_mutation",
          action: "grant",
          crossdeckCustomerId: "cdcust_x",
          entitlement: {
            object: "entitlement",
            key: "pro",
            isActive: true,
            validUntil: null,
            source: { rail: "manual", productId: "p", subscriptionId: "s" },
            updatedAt: 1,
          },
          env: "sandbox",
        }),
      );
    }) as unknown as typeof fetch;

    const results = await server().bulkGrantEntitlement([
      { customerId: "cdcust_a", entitlementKey: "pro", duration: "P30D", reason: "x" },
      { customerId: "cdcust_b", entitlementKey: "pro", duration: "P30D", reason: "x" },
      { customerId: "cdcust_c", entitlementKey: "pro", duration: "P30D", reason: "x" },
    ]);
    expect(results).toHaveLength(3);
    // Concurrent execution + 1 failure — verify result counts.
    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.filter((r) => !r.ok).length;
    expect(okCount).toBe(2);
    expect(failCount).toBe(1);
  });

  it("bulkRevokeEntitlement — same settled-array contract", async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          object: "entitlement_mutation",
          action: "revoke",
          crossdeckCustomerId: "cdcust_x",
          entitlement: {
            object: "entitlement",
            key: "pro",
            isActive: false,
            validUntil: null,
            source: { rail: "manual", productId: "p", subscriptionId: "s" },
            updatedAt: 1,
          },
          env: "sandbox",
        }),
      ),
    ) as unknown as typeof fetch;

    const results = await server().bulkRevokeEntitlement([
      { customerId: "cdcust_a", entitlementKey: "pro", reason: "x" },
      { customerId: "cdcust_b", entitlementKey: "pro", reason: "x" },
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("testMode (constructor option) — track() + flush() do NOT call fetch", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = new CrossdeckServer({
      secretKey: "cd_sk_test_001",
      sdkVersion: "0.1.0-test",
      errorCapture: false,
      flushOnExit: false,
      testMode: true,
    });
    try {
      s.track({ name: "x", developerUserId: "u" });
      await s.flush();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      s.shutdown();
    }
  });

  it("onRequest / onResponse hooks fire on every HTTP call (production + testMode)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "heartbeat", ok: true, projectId: "p", appId: "a", platform: "node", env: "sandbox", serverTime: 1 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const reqs: number[] = [];
    const ress: number[] = [];
    const s = new CrossdeckServer({
      secretKey: "cd_sk_test_001",
      sdkVersion: "0.1.0-test",
      errorCapture: false,
      flushOnExit: false,
      onRequest: (info) => reqs.push(info.attempt),
      onResponse: (info) => ress.push(info.status),
    });
    try {
      await s.heartbeat();
      expect(reqs).toEqual([1]);
      expect(ress).toEqual([200]);
    } finally {
      s.shutdown();
    }
  });

  it("AbortSignal — heartbeat({ signal }) cancels in-flight request", async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          const err: Error & { name?: string } = new Error("aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        init?.signal?.addEventListener("abort", () => {
          const err: Error & { name?: string } = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        }, { once: true });
      });
    }) as unknown as typeof fetch;

    const s = new CrossdeckServer({
      secretKey: "cd_sk_test_001",
      sdkVersion: "0.1.0-test",
      errorCapture: false,
      flushOnExit: false,
      timeoutMs: 0,
      httpRetries: { maxAttempts: 1 }, // no retries — abort surfaces immediately
    });
    try {
      const ctrl = new AbortController();
      const flight = s.heartbeat({ signal: ctrl.signal });
      setTimeout(() => ctrl.abort(), 20);
      await expect(flight).rejects.toMatchObject({ code: "request_aborted" });
    } finally {
      s.shutdown();
    }
  });

  it("shutdown() clears super-properties, groups, and entitlement cache", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        object: "list",
        data: [],
        crossdeckCustomerId: "cdcust_abc",
        env: "sandbox",
      }),
    ) as unknown as typeof fetch;

    const s = server();
    s.register({ tenant: "acme" });
    s.group("org", "acme_inc");
    await s.getEntitlements({ userId: "user_1" });
    expect(s.getSuperProperties()).toEqual({ tenant: "acme" });
    expect(s.getGroups()).toEqual({ org: { id: "acme_inc" } });
    expect(s.diagnostics().entitlements.count).toBe(1);

    s.shutdown();
    expect(s.getSuperProperties()).toEqual({});
    expect(s.getGroups()).toEqual({});
    expect(s.diagnostics().entitlements.count).toBe(0);
  });
});
