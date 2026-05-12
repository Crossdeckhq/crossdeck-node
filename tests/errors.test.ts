import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CrossdeckError,
  crossdeckErrorFromResponse,
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
