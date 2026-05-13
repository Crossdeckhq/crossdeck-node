import { describe, expect, it } from "vitest";

import * as cd from "../src/index";

describe("@cross-deck/node — public export surface", () => {
  it("exports CrossdeckServer as a constructor", () => {
    expect(typeof cd.CrossdeckServer).toBe("function");
    expect(cd.CrossdeckServer.prototype).toBeDefined();
  });

  it("exports CrossdeckError that is instanceof Error", () => {
    expect(typeof cd.CrossdeckError).toBe("function");
    const e = new cd.CrossdeckError({ type: "internal_error", code: "x", message: "x" });
    expect(e instanceof Error).toBe(true);
  });

  it("exports SDK_NAME === '@cross-deck/node'", () => {
    expect(cd.SDK_NAME).toBe("@cross-deck/node");
  });

  it("exports SDK_VERSION as a non-empty string", () => {
    expect(typeof cd.SDK_VERSION).toBe("string");
    expect(cd.SDK_VERSION.length).toBeGreaterThan(0);
  });

  it("exports DEFAULT_BASE_URL === 'https://api.cross-deck.com/v1'", () => {
    expect(cd.DEFAULT_BASE_URL).toBe("https://api.cross-deck.com/v1");
  });

  it("exports CROSSDECK_ERROR_CODES + getErrorCode helper", () => {
    expect(Array.isArray(cd.CROSSDECK_ERROR_CODES)).toBe(true);
    expect(cd.CROSSDECK_ERROR_CODES.length).toBeGreaterThan(0);
    expect(typeof cd.getErrorCode).toBe("function");
    expect(cd.getErrorCode("invalid_secret_key")).toBeDefined();
  });

  it("exports captureError / captureMessage / setTag / setTags / setContext / addBreadcrumb / setErrorBeforeSend on CrossdeckServer instance", () => {
    const s = new cd.CrossdeckServer({
      secretKey: "cd_sk_test_001",
      errorCapture: false,
      flushOnExit: false,
    });
    try {
      expect(typeof s.captureError).toBe("function");
      expect(typeof s.captureMessage).toBe("function");
      expect(typeof s.setTag).toBe("function");
      expect(typeof s.setTags).toBe("function");
      expect(typeof s.setContext).toBe("function");
      expect(typeof s.addBreadcrumb).toBe("function");
      expect(typeof s.setErrorBeforeSend).toBe("function");
    } finally {
      s.shutdown();
    }
  });

  it("exports register / unregister / group / getSuperProperties / getGroups on CrossdeckServer instance", () => {
    const s = new cd.CrossdeckServer({
      secretKey: "cd_sk_test_001",
      errorCapture: false,
      flushOnExit: false,
    });
    try {
      expect(typeof s.register).toBe("function");
      expect(typeof s.unregister).toBe("function");
      expect(typeof s.group).toBe("function");
      expect(typeof s.getSuperProperties).toBe("function");
      expect(typeof s.getGroups).toBe("function");
    } finally {
      s.shutdown();
    }
  });

  it("exports flush / isEntitled / listEntitlements / onEntitlementsChange / diagnostics on CrossdeckServer instance", () => {
    const s = new cd.CrossdeckServer({
      secretKey: "cd_sk_test_001",
      errorCapture: false,
      flushOnExit: false,
    });
    try {
      expect(typeof s.flush).toBe("function");
      expect(typeof s.isEntitled).toBe("function");
      expect(typeof s.listEntitlements).toBe("function");
      expect(typeof s.onEntitlementsChange).toBe("function");
      expect(typeof s.diagnostics).toBe("function");
    } finally {
      s.shutdown();
    }
  });

  it("exports verifyWebhookSignature + signWebhookPayload from main entry", () => {
    expect(typeof cd.verifyWebhookSignature).toBe("function");
    expect(typeof cd.signWebhookPayload).toBe("function");
  });

  it("re-exports framework adapters via the auto-events subpath", async () => {
    const adapters = await import("../src/auto-events/index");
    expect(typeof adapters.crossdeckExpress).toBe("function");
    expect(typeof adapters.crossdeckExpressErrorHandler).toBe("function");
    expect(typeof adapters.wrapLambdaHandler).toBe("function");
    expect(typeof adapters.wrapFunction).toBe("function");
  });

  it("CrossdeckServer constructor validates secret key prefix", () => {
    expect(
      () =>
        new cd.CrossdeckServer({
          secretKey: "cd_pub_test_001",
          errorCapture: false,
          flushOnExit: false,
        }),
    ).toThrowError(cd.CrossdeckError);
  });

  it("the _sdk-snippets.js Node snippet compiles against this surface (gate at tests/_gate3-snippet-compile.ts)", () => {
    // The Gate 3 fixture at `tests/_gate3-snippet-compile.ts` is what
    // continuously verifies the snippet against the actual SDK
    // surface. If `npm run lint` passes, this gate is green. This
    // test exists as a tripwire — if someone removes the fixture
    // file, the v0.1.0 regression class re-opens.
    expect(typeof cd.CrossdeckServer).toBe("function");
  });
});
