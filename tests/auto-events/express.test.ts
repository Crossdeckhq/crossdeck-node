import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CrossdeckServer } from "../../src/index";
import {
  crossdeckExpress,
  crossdeckExpressErrorHandler,
  extractRoutePattern,
  shouldSkipRequest,
  type ExpressRequestLike,
  type ExpressResponseLike,
} from "../../src/auto-events/express";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeServer(): CrossdeckServer {
  return new CrossdeckServer({
    secretKey: "cd_sk_test_001",
    errorCapture: false,
    flushOnExit: false,
  });
}

interface MockResponse extends ExpressResponseLike {
  statusCode: number;
  finishHandlers: Array<() => void>;
  closeHandlers: Array<() => void>;
}

function makeRes(): MockResponse {
  const finishHandlers: Array<() => void> = [];
  const closeHandlers: Array<() => void> = [];
  const res: MockResponse = {
    statusCode: 200,
    finishHandlers,
    closeHandlers,
    once(event, listener) {
      if (event === "finish") finishHandlers.push(listener);
      if (event === "close") closeHandlers.push(listener);
      return this;
    },
  };
  return res;
}

describe("crossdeckExpress middleware", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("emits request.handled on response 'finish' with route, method, statusCode, durationMs", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({ object: "list", received: 1, env: "sandbox" }, 202),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const mw = crossdeckExpress(server);
      const req: ExpressRequestLike = {
        method: "POST",
        url: "/users/42",
        path: "/users/42",
        route: { path: "/users/:id" },
      };
      const res = makeRes();
      const next = vi.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalledOnce();

      res.statusCode = 201;
      res.finishHandlers.forEach((fn) => fn());

      await server.flush();

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const event = body.events.find((e: { name: string }) => e.name === "request.handled");
      expect(event).toBeDefined();
      expect(event.properties.route).toBe("/users/:id");
      expect(event.properties.method).toBe("POST");
      expect(event.properties.statusCode).toBe(201);
      expect(typeof event.properties.durationMs).toBe("number");
    } finally {
      server.shutdown();
    }
  });

  it("extractRoutePattern uses the matched route pattern, not the full URL", () => {
    expect(
      extractRoutePattern({
        method: "GET",
        url: "/users/42",
        path: "/users/42",
        route: { path: "/users/:id" },
      }),
    ).toBe("/users/:id");
  });

  it("extractRoutePattern falls back to req.path when no route matched", () => {
    expect(extractRoutePattern({ method: "GET", url: "/missing", path: "/missing" })).toBe("/missing");
  });

  it("shouldSkipRequest matches default self-skip regex for /crossdeck/*", () => {
    expect(
      shouldSkipRequest(
        { method: "GET", url: "/crossdeck/health", path: "/crossdeck/health" },
        [/^\/crossdeck($|\/)/],
      ),
    ).toBe(true);
    expect(
      shouldSkipRequest({ method: "GET", url: "/api/users", path: "/api/users" }, [/^\/crossdeck($|\/)/]),
    ).toBe(false);
  });

  it("attaches identity via getIdentity option", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const mw = crossdeckExpress(server, {
        getIdentity: (req) => ({
          developerUserId: (req as ExpressRequestLike & { user?: { id: string } }).user?.id,
        }),
      });
      const req = {
        method: "GET",
        url: "/x",
        path: "/x",
        route: { path: "/x" },
        user: { id: "user_42" },
      } as ExpressRequestLike;
      const res = makeRes();
      mw(req, res, vi.fn());
      res.finishHandlers.forEach((fn) => fn());
      await server.flush();

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const event = body.events.find((e: { name: string }) => e.name === "request.handled");
      expect(event.developerUserId).toBe("user_42");
    } finally {
      server.shutdown();
    }
  });

  it("does not register response listeners for skipped requests", () => {
    const server = makeServer();
    try {
      const mw = crossdeckExpress(server);
      const req: ExpressRequestLike = {
        method: "GET",
        url: "/crossdeck/health",
        path: "/crossdeck/health",
      };
      const res = makeRes();
      const next = vi.fn();
      mw(req, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.finishHandlers).toHaveLength(0);
      expect(res.closeHandlers).toHaveLength(0);
    } finally {
      server.shutdown();
    }
  });

  it("emit-once semantics — finish followed by close does not double-emit request.handled", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const mw = crossdeckExpress(server);
      const req: ExpressRequestLike = {
        method: "GET",
        url: "/x",
        path: "/x",
        route: { path: "/x" },
      };
      const res = makeRes();
      mw(req, res, vi.fn());
      res.finishHandlers.forEach((fn) => fn());
      res.closeHandlers.forEach((fn) => fn());
      await server.flush();

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const events = body.events.filter((e: { name: string }) => e.name === "request.handled");
      expect(events).toHaveLength(1);
    } finally {
      server.shutdown();
    }
  });

  it("extracts userAgent header + responseBytes (Content-Length) on request.handled", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const mw = crossdeckExpress(server);
      const req: ExpressRequestLike = {
        method: "GET",
        url: "/x",
        path: "/x",
        route: { path: "/x" },
        headers: { "user-agent": "MyClient/1.0 (test)" },
      };
      const res = makeRes();
      // Add a getHeader implementation that returns content-length.
      (res as ExpressResponseLike & { getHeader: (name: string) => unknown }).getHeader = (n: string) =>
        n.toLowerCase() === "content-length" ? "1234" : undefined;
      mw(req, res, vi.fn());
      res.finishHandlers.forEach((fn) => fn());
      await server.flush();

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const event = body.events.find((e: { name: string }) => e.name === "request.handled");
      expect(event.properties.userAgent).toBe("MyClient/1.0 (test)");
      expect(event.properties.responseBytes).toBe(1234);
    } finally {
      server.shutdown();
    }
  });

  it("a throwing getIdentity does NOT break the request pipeline", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const mw = crossdeckExpress(server, {
        getIdentity: () => {
          throw new Error("auth context missing");
        },
      });
      const req: ExpressRequestLike = { method: "GET", url: "/x", path: "/x", route: { path: "/x" } };
      const res = makeRes();
      const next = vi.fn();
      expect(() => mw(req, res, next)).not.toThrow();
      res.finishHandlers.forEach((fn) => fn());
      await server.flush();
      // Event still ships, just without identity.
      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const event = body.events.find((e: { name: string }) => e.name === "request.handled");
      expect(event).toBeDefined();
    } finally {
      server.shutdown();
    }
  });
});

describe("crossdeckExpressErrorHandler", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("captures errors via server.captureError with request context, forwards via next()", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = new CrossdeckServer({
      secretKey: "cd_sk_test_001",
      flushOnExit: false,
      errorCapture: { onUncaughtException: false, onUnhandledRejection: false, wrapFetch: false },
    });
    try {
      const errMw = crossdeckExpressErrorHandler(server);
      const err = new Error("route crashed");
      const req: ExpressRequestLike = {
        method: "POST",
        url: "/api/x",
        originalUrl: "/api/x",
        route: { path: "/api/:id" },
      };
      const next = vi.fn();
      errMw(err, req, makeRes(), next);
      expect(next).toHaveBeenCalledWith(err);

      await server.flush();

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const event = body.events.find((e: { name: string }) => e.name === "error.handled");
      expect(event).toBeDefined();
      expect(event.properties.context.request).toEqual({
        url: "/api/x",
        method: "POST",
        route: "/api/:id",
      });
    } finally {
      server.shutdown();
    }
  });
});
