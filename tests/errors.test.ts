import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CrossdeckAuthenticationError,
  CrossdeckConfigurationError,
  CrossdeckError,
  CrossdeckInternalError,
  CrossdeckNetworkError,
  CrossdeckPermissionError,
  CrossdeckRateLimitError,
  CrossdeckValidationError,
  crossdeckErrorFromResponse,
  makeCrossdeckError,
  parseRetryAfterHeader,
} from "../src/errors";

describe("parseRetryAfterHeader", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses numeric retry-after seconds into milliseconds", () => {
    expect(parseRetryAfterHeader("2")).toBe(2_000);
    expect(parseRetryAfterHeader("1.5")).toBe(1_500);
  });

  it("returns undefined for blank and malformed values", () => {
    expect(parseRetryAfterHeader(null)).toBeUndefined();
    expect(parseRetryAfterHeader("")).toBeUndefined();
    expect(parseRetryAfterHeader("   ")).toBeUndefined();
    expect(parseRetryAfterHeader("soon")).toBeUndefined();
    expect(parseRetryAfterHeader("!")).toBeUndefined();
  });

  it("parses HTTP-date values and clamps past dates to zero", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T00:00:00.000Z"));

    expect(parseRetryAfterHeader("Tue, 12 May 2026 00:00:05 GMT")).toBe(5_000);
    expect(parseRetryAfterHeader("Mon, 11 May 2026 23:59:55 GMT")).toBe(0);
  });
});

describe("crossdeckErrorFromResponse", () => {
  it("keeps typed envelope fields and falls back to the header request ID", async () => {
    const err = await crossdeckErrorFromResponse(
      new Response(
        JSON.stringify({
          error: {
            type: "permission_error",
            code: "origin_not_allowed",
          },
        }),
        {
          status: 403,
          headers: { "x-request-id": "req_hdr_123" },
        },
      ),
    );

    expect(err).toBeInstanceOf(CrossdeckError);
    expect(err).toMatchObject({
      type: "permission_error",
      code: "origin_not_allowed",
      message: "HTTP 403",
      requestId: "req_hdr_123",
      status: 403,
    });
  });

  it("maps bare 429 responses to a rate-limit CrossdeckError and parses retry-after", async () => {
    const err = await crossdeckErrorFromResponse(
      new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        statusText: "Too Many Requests",
        headers: {
          "retry-after": "2",
          "x-request-id": "req_429",
        },
      }),
    );

    expect(err).toMatchObject({
      type: "rate_limit_error",
      code: "http_429",
      message: "HTTP 429 Too Many Requests",
      requestId: "req_429",
      status: 429,
      retryAfterMs: 2_000,
    });
  });

  it.each([
    [401, "authentication_error"],
    [403, "permission_error"],
    [404, "invalid_request_error"],
    [500, "internal_error"],
  ] as const)("maps bare HTTP %i to %s", async (status, type) => {
    const err = await crossdeckErrorFromResponse(
      new Response("not-json", {
        status,
        statusText: "status text",
      }),
    );

    expect(err).toMatchObject({
      type,
      code: `http_${status}`,
      message: `HTTP ${status} status text`,
      status,
    });
  });
});

describe("CrossdeckError.toJSON — for structured loggers", () => {
  it("serialises every field — type, code, requestId, status, retryAfterMs, message, stack", () => {
    const err = new CrossdeckError({
      type: "rate_limit_error",
      code: "too_many_requests",
      message: "slow down",
      requestId: "req_abc",
      status: 429,
      retryAfterMs: 5000,
    });
    const json = err.toJSON();
    expect(json).toMatchObject({
      name: "CrossdeckError",
      type: "rate_limit_error",
      code: "too_many_requests",
      message: "slow down",
      requestId: "req_abc",
      status: 429,
      retryAfterMs: 5000,
    });
    expect(typeof json.stack).toBe("string");
  });

  it("JSON.stringify(err) round-trips through toJSON", () => {
    const err = new CrossdeckError({
      type: "configuration_error",
      code: "invalid_secret_key",
      message: "bad key",
    });
    const round = JSON.parse(JSON.stringify(err));
    expect(round.type).toBe("configuration_error");
    expect(round.code).toBe("invalid_secret_key");
  });
});

describe("Error subclass hierarchy — Stripe-style instanceof narrowing", () => {
  it("CrossdeckAuthenticationError extends CrossdeckError", () => {
    const err = new CrossdeckAuthenticationError({
      type: "authentication_error",
      code: "invalid_secret_key",
      message: "bad",
    });
    expect(err).toBeInstanceOf(CrossdeckAuthenticationError);
    expect(err).toBeInstanceOf(CrossdeckError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CrossdeckAuthenticationError");
  });

  it("CrossdeckRateLimitError carries retryAfterMs", () => {
    const err = new CrossdeckRateLimitError({
      type: "rate_limit_error",
      code: "too_many_requests",
      message: "slow down",
      retryAfterMs: 30_000,
    });
    expect(err.retryAfterMs).toBe(30_000);
    expect(err).toBeInstanceOf(CrossdeckRateLimitError);
  });

  it("CrossdeckPermissionError + CrossdeckValidationError + CrossdeckNetworkError + CrossdeckInternalError + CrossdeckConfigurationError all extend CrossdeckError", () => {
    for (const Cls of [
      CrossdeckPermissionError,
      CrossdeckValidationError,
      CrossdeckNetworkError,
      CrossdeckInternalError,
      CrossdeckConfigurationError,
    ]) {
      const instance = new Cls({ type: "internal_error", code: "x", message: "x" });
      expect(instance).toBeInstanceOf(Cls);
      expect(instance).toBeInstanceOf(CrossdeckError);
      expect(instance).toBeInstanceOf(Error);
    }
  });
});

describe("makeCrossdeckError — picks the right subclass for the payload type", () => {
  it.each([
    ["authentication_error", CrossdeckAuthenticationError],
    ["permission_error", CrossdeckPermissionError],
    ["invalid_request_error", CrossdeckValidationError],
    ["rate_limit_error", CrossdeckRateLimitError],
    ["network_error", CrossdeckNetworkError],
    ["internal_error", CrossdeckInternalError],
    ["configuration_error", CrossdeckConfigurationError],
  ] as const)("maps type=%s to %s", (type, Cls) => {
    const err = makeCrossdeckError({ type, code: "x", message: "x" });
    expect(err).toBeInstanceOf(Cls);
    expect(err).toBeInstanceOf(CrossdeckError);
  });
});

describe("crossdeckErrorFromResponse returns the right subclass", () => {
  it("returns CrossdeckAuthenticationError for 401", async () => {
    const err = await crossdeckErrorFromResponse(
      new Response(JSON.stringify({ error: { type: "authentication_error", code: "invalid_secret_key", message: "x" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(err).toBeInstanceOf(CrossdeckAuthenticationError);
  });

  it("returns CrossdeckRateLimitError for 429 with Retry-After", async () => {
    const err = await crossdeckErrorFromResponse(
      new Response(JSON.stringify({ error: { type: "rate_limit_error", code: "slow_down", message: "x" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "30" },
      }),
    );
    expect(err).toBeInstanceOf(CrossdeckRateLimitError);
    expect(err.retryAfterMs).toBe(30_000);
  });

  it("returns CrossdeckInternalError for 500 bare", async () => {
    const err = await crossdeckErrorFromResponse(
      new Response("not-json", { status: 500, statusText: "Server Error" }),
    );
    expect(err).toBeInstanceOf(CrossdeckInternalError);
  });
});
