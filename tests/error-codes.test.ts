import { describe, expect, it } from "vitest";

import { CROSSDECK_ERROR_CODES, getErrorCode, isCrossdeckErrorCode } from "../src/error-codes";

describe("CROSSDECK_ERROR_CODES — Node catalogue", () => {
  it("every entry has unique code, type, description, resolution, retryable fields", () => {
    const codes = new Set<string>();
    for (const entry of CROSSDECK_ERROR_CODES) {
      expect(entry.code).toBeTypeOf("string");
      expect(entry.code.length).toBeGreaterThan(0);
      expect(codes.has(entry.code)).toBe(false);
      codes.add(entry.code);
      expect(entry.type).toBeTypeOf("string");
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.resolution.length).toBeGreaterThan(0);
      expect(typeof entry.retryable).toBe("boolean");
    }
  });

  it("every type is one of the CrossdeckErrorType union members", () => {
    const validTypes = new Set([
      "authentication_error",
      "permission_error",
      "invalid_request_error",
      "rate_limit_error",
      "version_error",
      "internal_error",
      "network_error",
      "configuration_error",
    ]);
    for (const entry of CROSSDECK_ERROR_CODES) {
      expect(validTypes.has(entry.type)).toBe(true);
    }
  });

  it("getErrorCode(code) returns the matching entry", () => {
    const entry = getErrorCode("invalid_secret_key");
    expect(entry).toBeDefined();
    expect(entry!.code).toBe("invalid_secret_key");
    expect(entry!.type).toBe("configuration_error");
  });

  it("getErrorCode('unknown') returns undefined", () => {
    expect(getErrorCode("nonexistent_code_xyz")).toBeUndefined();
  });

  it("ships Node-specific codes: flush_on_exit_failed, webhook_invalid_signature, webhook_replay_window_exceeded, webhook_missing_secret", () => {
    expect(getErrorCode("flush_on_exit_failed")).toBeDefined();
    expect(getErrorCode("webhook_invalid_signature")).toBeDefined();
    expect(getErrorCode("webhook_replay_window_exceeded")).toBeDefined();
    expect(getErrorCode("webhook_missing_secret")).toBeDefined();
  });

  it("does NOT ship browser-only codes (Node SDK has no env declaration or browser globals)", () => {
    expect(getErrorCode("environment_mismatch")).toBeUndefined();
    expect(getErrorCode("invalid_public_key")).toBeUndefined();
    expect(getErrorCode("missing_app_id")).toBeUndefined();
    expect(getErrorCode("invalid_environment")).toBeUndefined();
    expect(getErrorCode("not_initialized")).toBeUndefined();
  });

  it("network_error codes are flagged retryable: true", () => {
    expect(getErrorCode("fetch_failed")!.retryable).toBe(true);
    expect(getErrorCode("request_timeout")!.retryable).toBe(true);
  });

  it("configuration_error codes are flagged retryable: false", () => {
    expect(getErrorCode("invalid_secret_key")!.retryable).toBe(false);
    expect(getErrorCode("webhook_missing_secret")!.retryable).toBe(false);
  });

  it("ships missing_group_type for server.group() validation", () => {
    expect(getErrorCode("missing_group_type")).toBeDefined();
  });
});

describe("isCrossdeckErrorCode (typed narrowing guard)", () => {
  it("returns true for catalogue codes", () => {
    expect(isCrossdeckErrorCode("invalid_secret_key")).toBe(true);
    expect(isCrossdeckErrorCode("webhook_invalid_signature")).toBe(true);
    expect(isCrossdeckErrorCode("missing_group_type")).toBe(true);
  });

  it("returns false for unknown codes", () => {
    expect(isCrossdeckErrorCode("nonexistent_code_xyz")).toBe(false);
    expect(isCrossdeckErrorCode("")).toBe(false);
  });

  it("narrows the input type — TypeScript catches misspellings at compile time", () => {
    // This test exists primarily as documentation. The TS narrowing is
    // tested by `_gate3-snippet-compile.ts` at lint time — if the
    // following block compiled with a misspelling, the build would
    // fail. At runtime we just confirm the guard's logic.
    const code = "webhook_invalid_signature";
    if (isCrossdeckErrorCode(code)) {
      // Inside this branch, TypeScript narrows `code` to the literal
      // union. Comparing against catalogue strings is type-safe.
      expect(code === "webhook_invalid_signature").toBe(true);
    }
  });
});
