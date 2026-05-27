// Phase 3.1 contract tests — Node track() applies PII scrubber.
//
// Pre-v1.4.0 the Node SDK was the ONLY one that skipped
// scrubPiiFromProperties on the track() enqueue path, despite
// the README promising parity with Web/RN/Swift. The result:
// every Node-side track() call shipped emails + card-number-
// shaped substrings to Crossdeck UNREDACTED — a quiet privacy
// contract drift.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrossdeckServer } from "../src/index";

describe("Node track() — PII scrubber (Phase 3.1)", () => {
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

  function makeServer(opts: { scrubPii?: boolean } = {}): CrossdeckServer {
    return new CrossdeckServer({
      secretKey: "cd_sk_test_pii",
      appId: "app_test_pii",
      sdkVersion: "test",
      errorCapture: false,
      flushOnExit: false,
      bootHeartbeat: false,
      ...opts,
    });
  }

  function captureSentBody(): { calls: unknown[][]; fetchSpy: ReturnType<typeof vi.fn> } {
    const calls: unknown[][] = [];
    const fetchSpy = vi.fn().mockImplementation((_url, init: RequestInit) => {
      const body = init.body ? JSON.parse(init.body as string) : null;
      calls.push(body?.events ?? []);
      return Promise.resolve(jsonResponse({ object: "list", received: 1, env: "production" }, 202));
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    return { calls, fetchSpy };
  }

  it("by default redacts email-shaped values to <email>", async () => {
    const { calls } = captureSentBody();
    const s = makeServer();

    s.track({
      name: "user_signed_up",
      properties: { email: "alice@example.com", note: "hi alice@example.com!" },
    });
    await s.flush();
    await s.shutdown();

    const event = (calls[0] as Array<Record<string, unknown>>)[0];
    const props = event?.properties as Record<string, unknown>;
    expect(props["email"]).toBe("<email>");
    expect(props["note"]).toBe("hi <email>!");
  });

  it("redacts card-number-shaped values to <card>", async () => {
    const { calls } = captureSentBody();
    const s = makeServer();

    s.track({
      name: "checkout.completed",
      properties: { card: "4242 4242 4242 4242", chain: "user paid 4242424242424242" },
    });
    await s.flush();
    await s.shutdown();

    const event = (calls[0] as Array<Record<string, unknown>>)[0];
    const props = event?.properties as Record<string, unknown>;
    expect(props["card"]).toBe("<card>");
    expect(props["chain"]).toBe("user paid <card>");
  });

  it("walks nested maps + arrays", async () => {
    const { calls } = captureSentBody();
    const s = makeServer();

    s.track({
      name: "nested_test",
      properties: {
        user: { email: "deep@example.com", details: { contactEmails: ["a@b.com", "c@d.com"] } },
      },
    });
    await s.flush();
    await s.shutdown();

    const event = (calls[0] as Array<Record<string, unknown>>)[0];
    const props = event?.properties as Record<string, unknown>;
    const user = props["user"] as Record<string, unknown>;
    expect(user["email"]).toBe("<email>");
    const details = user["details"] as Record<string, unknown>;
    expect(details["contactEmails"]).toEqual(["<email>", "<email>"]);
  });

  it("scrubPii: false preserves the raw payload (opt-out)", async () => {
    // Compliance carve-out — regulator-required audit trails where
    // the raw value MUST be preserved. The blast-radius warning in
    // the option docstring is the contract.
    const { calls } = captureSentBody();
    const s = makeServer({ scrubPii: false });

    s.track({
      name: "audit.event",
      properties: { email: "raw@example.com" },
    });
    await s.flush();
    await s.shutdown();

    const event = (calls[0] as Array<Record<string, unknown>>)[0];
    const props = event?.properties as Record<string, unknown>;
    expect(props["email"]).toBe("raw@example.com");
  });

  it("scrubPii: true is the default when option is omitted", async () => {
    // Defence-in-depth — the constructor maps `undefined`/missing
    // to true. Only explicit `false` opts out.
    const { calls } = captureSentBody();
    const s = makeServer({});

    s.track({
      name: "default_test",
      properties: { email: "x@y.com" },
    });
    await s.flush();
    await s.shutdown();

    const event = (calls[0] as Array<Record<string, unknown>>)[0];
    const props = event?.properties as Record<string, unknown>;
    expect(props["email"]).toBe("<email>");
  });
});
