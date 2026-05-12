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

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function server() {
    return new CrossdeckServer({
      secretKey: "cd_sk_test_001",
      appId: "app_web_123",
      sdkVersion: "0.1.0-test",
    });
  }

  function serverWithoutAppId() {
    return new CrossdeckServer({
      secretKey: "cd_sk_test_001",
      baseUrl: "https://edge.cross-deck.test/v1",
      timeoutMs: 0,
      sdkVersion: "0.1.0-test",
    });
  }

  it("rejects non-secret keys at construction time", () => {
    expect(
      () =>
        new CrossdeckServer({
          secretKey: "cd_pub_test_001",
        }),
    ).toThrowError(CrossdeckError);
  });

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

  it("track() rejects events with no identity hint", async () => {
    await expect(server().track({ name: "checkout.started" })).rejects.toMatchObject({
      code: "missing_identity",
    });
  });

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
});
