import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleDebugLogger, NullDebugLogger, findSensitivePropertyKeys } from "../src/debug";

describe("ConsoleDebugLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no-ops when enabled === false", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logger = new ConsoleDebugLogger();
    expect(logger.enabled).toBe(false);
    logger.emit("sdk.configured", "test");
    expect(spy).not.toHaveBeenCalled();
  });

  it("logs sdk.configured when enabled", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logger = new ConsoleDebugLogger();
    logger.enabled = true;
    logger.emit("sdk.configured", "test message");
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toContain("[crossdeck:sdk.configured]");
    expect(spy.mock.calls[0]![0]).toContain("test message");
  });

  it("ONCE_SIGNALS (sdk.configured, sdk.first_event_sent) dedupe within one process", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logger = new ConsoleDebugLogger();
    logger.enabled = true;
    logger.emit("sdk.configured", "first");
    logger.emit("sdk.configured", "second");
    logger.emit("sdk.configured", "third");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("non-ONCE signals fire every time", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logger = new ConsoleDebugLogger();
    logger.enabled = true;
    logger.emit("sdk.flush_retry_scheduled", "first");
    logger.emit("sdk.flush_retry_scheduled", "second");
    logger.emit("sdk.flush_retry_scheduled", "third");
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("emits to console.info with the [crossdeck:<signal>] prefix", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logger = new ConsoleDebugLogger();
    logger.enabled = true;
    logger.emit("sdk.webhook_verified", "signature OK");
    expect(spy.mock.calls[0]![0]).toMatch(/^\[crossdeck:sdk\.webhook_verified\]/);
  });

  it("appends serialised context when provided", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logger = new ConsoleDebugLogger();
    logger.enabled = true;
    logger.emit("sdk.runtime_detected", "node info", { host: "aws-lambda" });
    expect(spy.mock.calls[0]![0]).toContain('"host":"aws-lambda"');
  });
});

describe("NullDebugLogger", () => {
  it("never calls console.info even when enabled is true", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logger = new NullDebugLogger();
    logger.enabled = true;
    logger.emit("sdk.configured", "test");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("findSensitivePropertyKeys", () => {
  it("flags 'email', 'password', 'token', 'secret', 'card', 'phone'", () => {
    const result = findSensitivePropertyKeys({
      email: "x@y.com",
      password: "p",
      token: "t",
      secret: "s",
      card: "c",
      phone: "p",
      safe_key: "ok",
    });
    expect(result.sort()).toEqual(["card", "email", "password", "phone", "secret", "token"]);
  });

  it("flags substring matches like 'credit_card' and 'oldPassword'", () => {
    const result = findSensitivePropertyKeys({
      credit_card: "c",
      oldPassword: "p",
    });
    expect(result.sort()).toEqual(["credit_card", "oldPassword"]);
  });

  it("returns [] for benign property names", () => {
    expect(findSensitivePropertyKeys({ tenant: "acme", plan: "pro" })).toEqual([]);
  });

  it("returns [] for undefined input", () => {
    expect(findSensitivePropertyKeys(undefined)).toEqual([]);
  });
});

describe("DebugSignal — Node-specific additions are valid signal names", () => {
  // Each signal name is a discriminated union member — adding a new
  // string would fail to compile. The runtime emits just confirm the
  // signals exist + don't throw.
  const logger = new ConsoleDebugLogger();
  logger.enabled = false;

  it("sdk.flush_on_exit_started is a valid signal", () => {
    expect(() => logger.emit("sdk.flush_on_exit_started", "msg")).not.toThrow();
  });

  it("sdk.flush_on_exit_completed is a valid signal", () => {
    expect(() => logger.emit("sdk.flush_on_exit_completed", "msg")).not.toThrow();
  });

  it("sdk.webhook_verified is a valid signal", () => {
    expect(() => logger.emit("sdk.webhook_verified", "msg")).not.toThrow();
  });

  it("sdk.runtime_detected is a valid signal", () => {
    expect(() => logger.emit("sdk.runtime_detected", "msg")).not.toThrow();
  });
});
