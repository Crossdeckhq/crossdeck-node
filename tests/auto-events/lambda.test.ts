import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CrossdeckServer } from "../../src/index";
import { wrapLambdaHandler, type LambdaContextLike } from "../../src/auto-events/lambda";

function makeServer(): CrossdeckServer {
  return new CrossdeckServer({
    secretKey: "cd_sk_test_001",
    flushOnExit: false,
    errorCapture: { onUncaughtException: false, onUnhandledRejection: false, wrapFetch: false },
  });
}

function makeCtx(overrides: Partial<LambdaContextLike> = {}): LambdaContextLike {
  return {
    awsRequestId: "req-abc123",
    functionName: "my-fn",
    functionVersion: "42",
    invokedFunctionArn: "arn:aws:lambda:us-east-1:000000000000:function:my-fn",
    memoryLimitInMB: 256,
    logStreamName: "log-stream-id",
    getRemainingTimeInMillis: () => 5000,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("wrapLambdaHandler — invocation lifecycle", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("emits function.invoked on entry with requestId, functionName, coldStart", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapLambdaHandler(server, async () => "ok", { resetColdStart: true });
      await handler({}, makeCtx());
      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const event = body.events.find((e: { name: string }) => e.name === "function.invoked");
      expect(event.properties.runtime).toBe("aws-lambda");
      expect(event.properties.requestId).toBe("req-abc123");
      expect(event.properties.functionName).toBe("my-fn");
      expect(event.properties.coldStart).toBe(true);
    } finally {
      server.shutdown();
    }
  });

  it("emits function.completed on success with durationMs + memoryUsedMb", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapLambdaHandler(server, async () => "result", { resetColdStart: true });
      const result = await handler({}, makeCtx());
      expect(result).toBe("result");

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const event = body.events.find((e: { name: string }) => e.name === "function.completed");
      expect(event).toBeDefined();
      expect(typeof event.properties.durationMs).toBe("number");
      expect(typeof event.properties.memoryUsedMb).toBe("number");
    } finally {
      server.shutdown();
    }
  });

  it("emits function.failed + error.handled on throw and re-throws", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapLambdaHandler(
        server,
        async () => {
          throw new Error("boom");
        },
        { resetColdStart: true },
      );
      await expect(handler({}, makeCtx())).rejects.toThrow("boom");

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const names = body.events.map((e: { name: string }) => e.name);
      expect(names).toContain("function.failed");
      expect(names).toContain("error.handled");
    } finally {
      server.shutdown();
    }
  });

  it("coldStart: true on first invocation, false on second (same wrapped handler)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapLambdaHandler(server, async () => "ok", { resetColdStart: true });
      await handler({}, makeCtx());
      await handler({}, makeCtx());

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
});

describe("wrapLambdaHandler — flush-before-return contract", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("awaits server.flush() BEFORE returning success (events land before the platform freezes)", async () => {
    const order: string[] = [];
    const fetchSpy = vi.fn().mockImplementation(async () => {
      order.push("flush-fetch");
      return jsonResponse({ received: 1 }, 202);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapLambdaHandler(server, async () => "ok", { resetColdStart: true });
      await handler({}, makeCtx());
      order.push("post-await");
      expect(order.indexOf("flush-fetch")).toBeLessThan(order.indexOf("post-await"));
    } finally {
      server.shutdown();
    }
  });

  it("awaits flush even on the failed path", async () => {
    let flushCalled = false;
    const fetchSpy = vi.fn().mockImplementation(() => {
      flushCalled = true;
      return Promise.resolve(jsonResponse({ received: 1 }, 202));
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapLambdaHandler(
        server,
        async () => {
          throw new Error("boom");
        },
        { resetColdStart: true },
      );
      await expect(handler({}, makeCtx())).rejects.toThrow();
      expect(flushCalled).toBe(true);
    } finally {
      server.shutdown();
    }
  });

  it("flush failure does NOT block the handler's return value", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapLambdaHandler(server, async () => "ok", { resetColdStart: true });
      const result = await handler({}, makeCtx());
      expect(result).toBe("ok");
    } finally {
      server.shutdown();
    }
  });
});

describe("wrapLambdaHandler — error capture", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uncaught errors capture as error.handled with parsed frames + lambda context", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapLambdaHandler(
        server,
        async () => {
          throw new Error("uncaught");
        },
        { resetColdStart: true },
      );
      await expect(handler({}, makeCtx())).rejects.toThrow();

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const errorEvent = body.events.find((e: { name: string }) => e.name === "error.handled");
      expect(errorEvent).toBeDefined();
      expect(errorEvent.properties.message).toBe("uncaught");
      expect(errorEvent.properties.context.lambda.functionName).toBe("my-fn");
      expect(errorEvent.properties.context.lambda.requestId).toBe("req-abc123");
    } finally {
      server.shutdown();
    }
  });

  it("the original throw propagates after capture (so Lambda still reports failure to CloudWatch)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ received: 1 }, 202)) as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapLambdaHandler(
        server,
        async () => {
          throw new Error("specific message");
        },
        { resetColdStart: true },
      );
      await expect(handler({}, makeCtx())).rejects.toThrow("specific message");
    } finally {
      server.shutdown();
    }
  });
});

describe("wrapLambdaHandler — return values + identity", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the wrapped handler's resolved value unchanged", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ received: 1 }, 202)) as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapLambdaHandler(
        server,
        async () => ({ statusCode: 200, body: "ok" }),
        { resetColdStart: true },
      );
      const result = await handler({}, makeCtx());
      expect(result).toEqual({ statusCode: 200, body: "ok" });
    } finally {
      server.shutdown();
    }
  });

  it("extracts statusCode + responseBytes for HTTP-style returns (API Gateway / Function URL / ALB)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapLambdaHandler(
        server,
        async () => ({ statusCode: 418, body: '{"error":"teapot"}' }),
        { resetColdStart: true },
      );
      await handler({}, makeCtx());
      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const completed = body.events.find((e: { name: string }) => e.name === "function.completed");
      expect(completed.properties.statusCode).toBe(418);
      expect(completed.properties.responseBytes).toBe(18); // length of '{"error":"teapot"}'
    } finally {
      server.shutdown();
    }
  });

  it("does NOT add statusCode/responseBytes for non-HTTP returns (queue / cron handlers)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapLambdaHandler(
        server,
        async () => ({ recordsProcessed: 42 }),
        { resetColdStart: true },
      );
      await handler({}, makeCtx());
      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const completed = body.events.find((e: { name: string }) => e.name === "function.completed");
      expect(completed.properties.statusCode).toBeUndefined();
      expect(completed.properties.responseBytes).toBeUndefined();
    } finally {
      server.shutdown();
    }
  });

  it("supports synchronous handlers returning a value", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ received: 1 }, 202)) as unknown as typeof fetch;

    const server = makeServer();
    try {
      const handler = wrapLambdaHandler(server, () => "sync-ok", { resetColdStart: true });
      const result = await handler({}, makeCtx());
      expect(result).toBe("sync-ok");
    } finally {
      server.shutdown();
    }
  });

  it("getIdentity is invoked once per request and attaches to events", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ received: 1 }, 202));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const getIdentity = vi.fn().mockReturnValue({ developerUserId: "user_42" });
    const server = makeServer();
    try {
      const handler = wrapLambdaHandler(server, async () => "ok", {
        resetColdStart: true,
        getIdentity,
      });
      await handler({ requestContext: { user: "u" } }, makeCtx());
      expect(getIdentity).toHaveBeenCalledOnce();

      const body = JSON.parse(fetchSpy.mock.calls[0]![1].body as string);
      const event = body.events.find((e: { name: string }) => e.name === "function.invoked");
      expect(event.developerUserId).toBe("user_42");
    } finally {
      server.shutdown();
    }
  });
});
