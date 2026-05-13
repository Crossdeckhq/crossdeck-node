import { describe, expect, it } from "vitest";

import { CrossdeckError } from "../src/errors";
import { signWebhookPayload, verifyWebhookSignature } from "../src/webhooks";

const SECRET = "whsec_test_001";
/** Fixed reference time so timestamp assertions are deterministic. */
const NOW = 1_717_891_200_000; // 2024-06-09T00:00:00Z

function makeHeader(payload: string, secret: string, timestampMs: number): string {
  const ts = Math.floor(timestampMs / 1000);
  const sig = signWebhookPayload(payload, secret, ts);
  return `t=${ts},v1=${sig}`;
}

describe("verifyWebhookSignature — happy path", () => {
  it("valid HMAC-SHA256 signature verifies and returns the parsed payload", () => {
    const payload = JSON.stringify({ object: "event.entitlement.granted", customerId: "cdcust_x" });
    const header = makeHeader(payload, SECRET, NOW);
    const result = verifyWebhookSignature(payload, header, SECRET, { now: () => NOW });
    expect(result).toEqual({ object: "event.entitlement.granted", customerId: "cdcust_x" });
  });

  it("supports the Stripe-style 't=<unix>,v1=<hex>' header format", () => {
    const payload = '{"x":1}';
    const header = makeHeader(payload, SECRET, NOW);
    expect(() => verifyWebhookSignature(payload, header, SECRET, { now: () => NOW })).not.toThrow();
  });

  it("header field order is irrelevant (v1 before t works equally)", () => {
    const payload = '{"x":1}';
    const ts = Math.floor(NOW / 1000);
    const sig = signWebhookPayload(payload, SECRET, ts);
    const header = `v1=${sig},t=${ts}`;
    expect(() => verifyWebhookSignature(payload, header, SECRET, { now: () => NOW })).not.toThrow();
  });

  it("accepts header passed as a single-element string[] (Node http.IncomingMessage shape)", () => {
    const payload = '{"x":1}';
    const header = makeHeader(payload, SECRET, NOW);
    expect(() => verifyWebhookSignature(payload, [header], SECRET, { now: () => NOW })).not.toThrow();
  });
});

describe("verifyWebhookSignature — rejections", () => {
  it("tampered payload throws CrossdeckError({ code: 'webhook_invalid_signature' })", () => {
    const orig = '{"x":1}';
    const header = makeHeader(orig, SECRET, NOW);
    try {
      verifyWebhookSignature('{"x":2}', header, SECRET, { now: () => NOW });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CrossdeckError);
      expect((err as CrossdeckError).code).toBe("webhook_invalid_signature");
    }
  });

  it("tampered signature throws webhook_invalid_signature", () => {
    const payload = '{"x":1}';
    const ts = Math.floor(NOW / 1000);
    const header = `t=${ts},v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`;
    try {
      verifyWebhookSignature(payload, header, SECRET, { now: () => NOW });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as CrossdeckError).code).toBe("webhook_invalid_signature");
    }
  });

  it("missing secret throws webhook_missing_secret", () => {
    const payload = '{"x":1}';
    const header = makeHeader(payload, SECRET, NOW);
    try {
      verifyWebhookSignature(payload, header, undefined, { now: () => NOW });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as CrossdeckError).code).toBe("webhook_missing_secret");
    }
  });

  it("empty-string secret throws webhook_missing_secret", () => {
    const payload = '{"x":1}';
    const header = makeHeader(payload, SECRET, NOW);
    try {
      verifyWebhookSignature(payload, header, "", { now: () => NOW });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as CrossdeckError).code).toBe("webhook_missing_secret");
    }
  });

  it("timestamp older than replayToleranceMs (default 5 min) throws webhook_replay_window_exceeded", () => {
    const payload = '{"x":1}';
    const header = makeHeader(payload, SECRET, NOW - 10 * 60_000);
    try {
      verifyWebhookSignature(payload, header, SECRET, { now: () => NOW });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as CrossdeckError).code).toBe("webhook_replay_window_exceeded");
    }
  });

  it("malformed header (no t= or no v1=) throws webhook_invalid_signature", () => {
    for (const header of ["bogus", "t=123", "v1=abc"]) {
      try {
        verifyWebhookSignature('{"x":1}', header, SECRET, { now: () => NOW });
        throw new Error(`expected to throw for header: ${header}`);
      } catch (err) {
        expect(err).toBeInstanceOf(CrossdeckError);
        expect((err as CrossdeckError).code).toBe("webhook_invalid_signature");
      }
    }
  });

  it("future-dated timestamp beyond tolerance throws (clock-skew defence)", () => {
    const payload = '{"x":1}';
    const header = makeHeader(payload, SECRET, NOW + 10 * 60_000);
    try {
      verifyWebhookSignature(payload, header, SECRET, { now: () => NOW });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as CrossdeckError).code).toBe("webhook_replay_window_exceeded");
    }
  });

  it("valid signature but non-JSON payload throws webhook_invalid_signature", () => {
    const payload = "not json {";
    const header = makeHeader(payload, SECRET, NOW);
    try {
      verifyWebhookSignature(payload, header, SECRET, { now: () => NOW });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as CrossdeckError).code).toBe("webhook_invalid_signature");
    }
  });
});

describe("verifyWebhookSignature — knobs", () => {
  it("custom replayToleranceMs overrides the 5-min default", () => {
    const payload = '{"x":1}';
    const header = makeHeader(payload, SECRET, NOW - 30 * 60_000);
    expect(() =>
      verifyWebhookSignature(payload, header, SECRET, {
        now: () => NOW,
        replayToleranceMs: 60 * 60_000,
      }),
    ).not.toThrow();
  });

  it("tolerance of 0 disables the replay window (caller opts out)", () => {
    const payload = '{"x":1}';
    const ancient = NOW - 365 * 24 * 60 * 60_000;
    const header = makeHeader(payload, SECRET, ancient);
    expect(() =>
      verifyWebhookSignature(payload, header, SECRET, { now: () => NOW, replayToleranceMs: 0 }),
    ).not.toThrow();
  });

  it("supports multiple secrets for rotation — any match wins", () => {
    const payload = '{"x":1}';
    const header = makeHeader(payload, SECRET, NOW);
    expect(() =>
      verifyWebhookSignature(payload, header, ["whsec_old_stale", SECRET], { now: () => NOW }),
    ).not.toThrow();
  });
});

describe("signWebhookPayload (exported for fixture authors)", () => {
  it("produces deterministic 64-char hex for the same input", () => {
    const a = signWebhookPayload('{"x":1}', SECRET, 1_700_000_000);
    const b = signWebhookPayload('{"x":1}', SECRET, 1_700_000_000);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different payload yields different signature", () => {
    const a = signWebhookPayload('{"x":1}', SECRET, 1_700_000_000);
    const b = signWebhookPayload('{"x":2}', SECRET, 1_700_000_000);
    expect(a).not.toBe(b);
  });
});
