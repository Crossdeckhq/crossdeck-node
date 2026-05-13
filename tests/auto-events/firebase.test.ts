import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CrossdeckServer } from "../../src/index";
import { wrapFunction } from "../../src/auto-events/firebase";

function makeServer(): CrossdeckServer {
  return new CrossdeckServer({
    secretKey: "cd_sk_test_001",
    flushOnExit: false,
    errorCapture: { onUncaughtException: false, onUnhandledRejection: false, wrapFetch: false },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("wrapFunction — Firebase v1 + v2 + Cloud Run", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("emits function.invoked on entry with default runtime label 'firebase-functions'", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapFunction(server, async () => "ok", { resetColdStart: true });
      await handler();
      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const event = body.events.find((e: { name: string }) => e.name === "function.invoked");
      expect(event.properties.runtime).toBe("firebase-functions");
      expect(event.properties.coldStart).toBe(true);
    } finally {
      server.shutdown();
    }
  });

  it("custom runtime label overrides the default", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapFunction(server, async () => "ok", {
        resetColdStart: true,
        runtime: "cloud-run-https",
      });
      await handler();
      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const event = body.events.find((e: { name: string }) => e.name === "function.invoked");
      expect(event.properties.runtime).toBe("cloud-run-https");
    } finally {
      server.shutdown();
    }
  });

  it("emits function.completed on success with durationMs", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapFunction(server, async () => "result", { resetColdStart: true });
      const result = await handler();
      expect(result).toBe("result");

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const event = body.events.find((e: { name: string }) => e.name === "function.completed");
      expect(event).toBeDefined();
      expect(typeof event.properties.durationMs).toBe("number");
    } finally {
      server.shutdown();
    }
  });

  it("emits function.failed + error.handled on throw and re-throws", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapFunction(
        server,
        async () => {
          throw new Error("boom");
        },
        { resetColdStart: true },
      );
      await expect(handler()).rejects.toThrow("boom");

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const names = body.events.map((e: { name: string }) => e.name);
      expect(names).toContain("function.failed");
      expect(names).toContain("error.handled");
    } finally {
      server.shutdown();
    }
  });

  it("getMetadata extracts identity + properties from args", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapFunction(
        server,
        async (_req: { method: string; path: string; user?: { uid: string } }) => "ok",
        {
          resetColdStart: true,
          getMetadata: (args) => {
            const req = args[0] as { method: string; path: string; user?: { uid: string } };
            return {
              identity: { developerUserId: req.user?.uid },
              properties: { method: req.method, path: req.path },
            };
          },
        },
      );
      await handler({ method: "POST", path: "/api/x", user: { uid: "user_42" } });

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const event = body.events.find((e: { name: string }) => e.name === "function.invoked");
      expect(event.developerUserId).toBe("user_42");
      expect(event.properties.method).toBe("POST");
      expect(event.properties.path).toBe("/api/x");
    } finally {
      server.shutdown();
    }
  });

  it("a throwing getMetadata is swallowed — handler still runs", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapFunction(server, async () => "ok", {
        resetColdStart: true,
        getMetadata: () => {
          throw new Error("extractor crashed");
        },
      });
      const result = await handler();
      expect(result).toBe("ok");
    } finally {
      server.shutdown();
    }
  });

  it("coldStart flips false after the first invocation", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapFunction(server, async () => "ok", { resetColdStart: true });
      await handler();
      await handler();

      const firstBody = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const secondBody = JSON.parse(fetchSpy.mock.calls[1]![1].body as string);
      const findInvoked = (b: { events: Array<{ name: string; properties: { coldStart: boolean } }> }) =>
        b.events.find((e) => e.name === "function.invoked");
      expect(findInvoked(firstBody)!.properties.coldStart).toBe(true);
      expect(findInvoked(secondBody)!.properties.coldStart).toBe(false);
    } finally {
      server.shutdown();
    }
  });

  it("awaits server.flush() before returning success (Cloud Functions freezes between invocations)", async () => {
    const order: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      order.push("flush-fetch");
      return jsonResponse({ received: 1 }, 202);
    }) as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapFunction(server, async () => "result", { resetColdStart: true });
      await handler();
      order.push("post-await");
      expect(order.indexOf("flush-fetch")).toBeLessThan(order.indexOf("post-await"));
    } finally {
      server.shutdown();
    }
  });

  it("returns the wrapped handler's resolved value unchanged", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ received: 1 }, 202)) as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapFunction(server, async (n: number) => n * 2, { resetColdStart: true });
      const result = await handler(21);
      expect(result).toBe(42);
    } finally {
      server.shutdown();
    }
  });

  it("supports synchronous handlers", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ received: 1 }, 202)) as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapFunction(server, (): string => "sync-ok", { resetColdStart: true });
      const result = await handler();
      expect(result).toBe("sync-ok");
    } finally {
      server.shutdown();
    }
  });

  it("flush failure does NOT block the handler's return value", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network")) as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapFunction(server, async () => "ok", { resetColdStart: true });
      const result = await handler();
      expect(result).toBe("ok");
    } finally {
      server.shutdown();
    }
  });

  it("preserves the handler's TypeScript signature (compile-time check via generic)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ received: 1 }, 202)) as unknown as typeof fetch;

    const server = makeServer();
    try {
      // Signature: (req, res) => Promise<void>. Wrapped handler has
      // the same shape — tsc enforces at compile time.
      const handler = wrapFunction(
        server,
        async (_req: { method: string }, _res: { send: (s: string) => void }): Promise<void> => undefined,
        { resetColdStart: true },
      );
      await handler({ method: "GET" }, { send: () => undefined });
      // No type-level error means the test passes.
      expect(typeof handler).toBe("function");
    } finally {
      server.shutdown();
    }
  });

  it("getMetadata returning null/undefined is handled gracefully", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapFunction(server, async () => "ok", {
        resetColdStart: true,
        getMetadata: () => null,
      });
      const result = await handler();
      expect(result).toBe("ok");

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const event = body.events.find((e: { name: string }) => e.name === "function.invoked");
      expect(event).toBeDefined();
    } finally {
      server.shutdown();
    }
  });

  it("Cloud Run support: same flush-on-exit gating applies (long-lived HTTP server pattern)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      // Cloud Run typically runs a long-lived process — wrapFunction
      // here is for individual invocation tracking, same as Firebase.
      const handler = wrapFunction(server, async () => "ok", {
        resetColdStart: true,
        runtime: "cloud-run",
      });
      await handler();
      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const event = body.events.find((e: { name: string }) => e.name === "function.invoked");
      expect(event.properties.runtime).toBe("cloud-run");
    } finally {
      server.shutdown();
    }
  });
});
