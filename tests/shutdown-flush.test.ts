// Phase 5.4 contract tests — Node shutdown() must await flush().
//
// Pre-v1.4.0: shutdown() called eventQueue.reset() immediately,
// dropping every queued event without an attempt to flush. A
// regression here would silently lose every event between the last
// successful flush and shutdown — silent revenue/analytics loss.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrossdeckServer } from "../src/index";

describe("CrossdeckServer shutdown — bank-grade flush contract", () => {
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

  function newServer(): CrossdeckServer {
    return new CrossdeckServer({
      secretKey: "cd_sk_test_001",
      appId: "app_web_123",
      sdkVersion: "0.1.0-test",
      errorCapture: false,
      flushOnExit: false,
      bootHeartbeat: false,
    });
  }

  it("async shutdown() flushes queued events before clearing", async () => {
    const sent: unknown[][] = [];
    const fetchSpy = vi.fn().mockImplementation((_url, init: RequestInit) => {
      const body = init.body ? JSON.parse(init.body as string) : null;
      sent.push(body?.data ?? []);
      return Promise.resolve(jsonResponse({ object: "list", received: 1, env: "production" }, 202));
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const s = newServer();
    s.track({ name: "test.event", properties: { foo: "bar" } });

    // Pre-flush: queue should have the event buffered.
    expect(s.diagnostics().events.buffered).toBeGreaterThan(0);

    await s.shutdown();

    // shutdown() MUST have flushed — fetch was called with the event.
    expect(fetchSpy).toHaveBeenCalled();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]!.length).toBeGreaterThan(0);
  });

  it("async shutdown() proceeds with teardown even if flush fails", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("simulated network failure")) as unknown as typeof fetch;

    const s = newServer();
    s.track({ name: "test.event", properties: { foo: "bar" } });

    // The async shutdown() MUST NOT throw — best-effort drain
    // followed by sync teardown.
    await expect(s.shutdown()).resolves.toBeUndefined();
  });

  it("sync shutdownSync() warns when the buffer has events at teardown", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const s = newServer();
    s.track({ name: "test.event_a", properties: { foo: "bar" } });
    s.track({ name: "test.event_b", properties: { foo: "baz" } });

    s.shutdownSync();

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain("dropped");
    expect(warnMsg).toContain("queued event");
    expect(warnMsg).toMatch(/await server\.shutdown\(\)|asyncDispose/);
    warnSpy.mockRestore();
  });

  it("sync shutdownSync() with empty buffer does NOT warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = newServer();
    s.shutdownSync();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("[Symbol.asyncDispose] equals await server.shutdown()", async () => {
    const sent: unknown[][] = [];
    globalThis.fetch = vi.fn().mockImplementation((_url, init: RequestInit) => {
      const body = init.body ? JSON.parse(init.body as string) : null;
      sent.push(body?.data ?? []);
      return Promise.resolve(jsonResponse({ object: "list", received: 1, env: "production" }, 202));
    }) as unknown as typeof fetch;

    const s = newServer();
    s.track({ name: "disposed.event", properties: { x: 1 } });

    await s[Symbol.asyncDispose]();

    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]!.length).toBeGreaterThan(0);
  });
});
