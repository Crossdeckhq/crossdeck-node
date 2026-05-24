import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BreadcrumbBuffer } from "../src/breadcrumbs";
import {
  DEFAULT_ERROR_CAPTURE,
  ErrorTracker,
  extractSelfHostname,
  isSelfRequest,
  type CapturedError,
  type ErrorCaptureConfig,
  type ErrorTrackerOptions,
} from "../src/error-capture";

/**
 * Build a tracker with all global hooks disabled by default — tests of
 * the manual captureError/captureMessage surface don't need
 * `process.on(...)` listeners installed. Tests that DO want the global
 * hooks pass them in explicitly via `configOverrides`.
 */
function makeTracker(
  configOverrides: Partial<ErrorCaptureConfig> = {},
  optionsOverrides: Partial<ErrorTrackerOptions> = {},
): { tracker: ErrorTracker; reports: CapturedError[]; breadcrumbs: BreadcrumbBuffer } {
  const reports: CapturedError[] = [];
  const breadcrumbs = new BreadcrumbBuffer();
  const config: ErrorCaptureConfig = {
    ...DEFAULT_ERROR_CAPTURE,
    onUncaughtException: false,
    onUnhandledRejection: false,
    wrapFetch: false,
    captureConsole: false,
    ...configOverrides,
  };
  const tracker = new ErrorTracker({
    config,
    breadcrumbs,
    report: (e) => reports.push(e),
    getContext: () => ({}),
    getTags: () => ({}),
    isConsented: () => true,
    ...optionsOverrides,
  });
  tracker.install();
  return { tracker, reports, breadcrumbs };
}

describe("captureError — manual API", () => {
  it("captureError(new Error('boom')) builds a CapturedError with parsed frames + fingerprint", () => {
    const { tracker, reports } = makeTracker();
    try {
      tracker.captureError(new Error("boom"));
      expect(reports).toHaveLength(1);
      expect(reports[0]!.kind).toBe("error.handled");
      expect(reports[0]!.message).toBe("boom");
      expect(reports[0]!.errorType).toBe("Error");
      expect(reports[0]!.fingerprint).toMatch(/^[0-9a-f]{8}$/);
      expect(reports[0]!.frames.length).toBeGreaterThan(0);
    } finally {
      tracker.uninstall();
    }
  });

  it("captureError merges options.context with tracker-level context", () => {
    const { tracker, reports } = makeTracker(
      {},
      { getContext: () => ({ session: "s1" }) },
    );
    try {
      tracker.captureError(new Error("boom"), { context: { extra: "x" } });
      expect(reports[0]!.context).toEqual({ session: "s1", extra: "x" });
    } finally {
      tracker.uninstall();
    }
  });

  it("captureError merges options.tags with tracker-level tags", () => {
    const { tracker, reports } = makeTracker(
      {},
      { getTags: () => ({ release: "v1" }) },
    );
    try {
      tracker.captureError(new Error("boom"), { tags: { flow: "checkout" } });
      expect(reports[0]!.tags).toEqual({ release: "v1", flow: "checkout" });
    } finally {
      tracker.uninstall();
    }
  });

  it("captureError(non-Error) coerces via safeStringify and ships error.handled", () => {
    const { tracker, reports } = makeTracker();
    try {
      tracker.captureError("just a string");
      expect(reports[0]!.kind).toBe("error.handled");
      expect(reports[0]!.message).toBe("just a string");
      expect(reports[0]!.errorType).toBeNull();
      expect(reports[0]!.frames).toEqual([]);
    } finally {
      tracker.uninstall();
    }
  });

  it("captureError is silent when isConsented returns false (never throws)", () => {
    const { tracker, reports } = makeTracker({}, { isConsented: () => false });
    try {
      expect(() => tracker.captureError(new Error("boom"))).not.toThrow();
      expect(reports).toHaveLength(0);
    } finally {
      tracker.uninstall();
    }
  });

  it("captureError(err, { level: 'warning' }) ships level === 'warning'", () => {
    const { tracker, reports } = makeTracker();
    try {
      tracker.captureError(new Error("boom"), { level: "warning" });
      expect(reports[0]!.level).toBe("warning");
    } finally {
      tracker.uninstall();
    }
  });
});

describe("captureError — non-Error payload coercion (post-1.0.1 upgrade)", () => {
  it("plain object with message field preserves constructor name + extras", () => {
    const { tracker, reports } = makeTracker();
    class ApiError {
      readonly code = 500;
      readonly message = "server fell over";
    }
    try {
      tracker.captureError(new ApiError());
      expect(reports[0]!.message).toBe("server fell over");
      expect(reports[0]!.errorType).toBe("ApiError");
      expect((reports[0]!.context as Record<string, unknown>).__error_extras).toMatchObject({
        code: 500,
      });
    } finally {
      tracker.uninstall();
    }
  });

  it("null and undefined throws get explicit labels (not 'Unknown error')", () => {
    const { tracker, reports } = makeTracker();
    try {
      tracker.captureError(null);
      tracker.captureError(undefined);
      expect(reports[0]!.message).toBe("(thrown: null)");
      expect(reports[1]!.message).toBe("(thrown: undefined)");
    } finally {
      tracker.uninstall();
    }
  });

  it("Error.cause chain lands in extras", () => {
    const { tracker, reports } = makeTracker();
    try {
      const root = new Error("ECONNREFUSED upstream");
      const wrapper = new Error("payment service unreachable");
      // ES2020 target — assign cause as a runtime field rather than
      // using the ES2022 constructor option.
      (wrapper as Error & { cause: unknown }).cause = root;
      tracker.captureError(wrapper);
      const extras = (reports[0]!.context as Record<string, unknown>).__error_extras as {
        cause: Array<{ name: string; message: string }>;
      };
      expect(extras.cause).toEqual([{ name: "Error", message: "ECONNREFUSED upstream" }]);
    } finally {
      tracker.uninstall();
    }
  });

  it("captures Node-style code/errno/syscall on Error subclasses", () => {
    const { tracker, reports } = makeTracker();
    try {
      class SystemError extends Error {
        readonly code = "ENOENT";
        readonly errno = -2;
        readonly syscall = "open";
        readonly path = "/tmp/missing";
        constructor(msg: string) {
          super(msg);
          this.name = "SystemError";
        }
      }
      tracker.captureError(new SystemError("no such file"));
      expect(reports[0]!.errorType).toBe("SystemError");
      expect((reports[0]!.context as Record<string, unknown>).__error_extras).toMatchObject({
        code: "ENOENT",
        errno: -2,
        syscall: "open",
        path: "/tmp/missing",
      });
    } finally {
      tracker.uninstall();
    }
  });

  it("AggregateError.errors is unwrapped into extras.aggregatedErrors", () => {
    const { tracker, reports } = makeTracker();
    try {
      // Some test environments may not have AggregateError on globalThis.
      const Agg = (globalThis as { AggregateError?: typeof AggregateError }).AggregateError;
      if (!Agg) return;
      const inner = [new Error("dns failed"), new Error("timeout")];
      const agg = new Agg(inner, "All upstreams failed");
      tracker.captureError(agg);
      expect(reports[0]!.errorType).toBe("AggregateError");
      const extras = (reports[0]!.context as Record<string, unknown>).__error_extras as {
        aggregatedErrors: Array<{ name: string; message: string }>;
      };
      expect(extras.aggregatedErrors).toEqual([
        { name: "Error", message: "dns failed" },
        { name: "Error", message: "timeout" },
      ]);
    } finally {
      tracker.uninstall();
    }
  });

  it("two non-Error throws of different shapes get DIFFERENT fingerprints", () => {
    // Regression: the old code collapsed every empty-frame non-Error
    // throw under a single fingerprint regardless of payload.
    const { tracker, reports } = makeTracker();
    try {
      tracker.captureError({ code: 500, where: "a" });
      tracker.captureError({ code: 500, where: "b" });
      expect(reports).toHaveLength(2);
      expect(reports[0]!.fingerprint).not.toBe(reports[1]!.fingerprint);
    } finally {
      tracker.uninstall();
    }
  });
});

describe("captureMessage — Sentry pattern", () => {
  it("captureMessage('hi', 'info') ships kind === 'error.message' with empty frames", () => {
    const { tracker, reports } = makeTracker();
    try {
      tracker.captureMessage("hi", "info");
      expect(reports[0]!.kind).toBe("error.message");
      expect(reports[0]!.level).toBe("info");
      expect(reports[0]!.message).toBe("hi");
      expect(reports[0]!.frames).toEqual([]);
    } finally {
      tracker.uninstall();
    }
  });

  it("captureMessage default level is 'info'", () => {
    const { tracker, reports } = makeTracker();
    try {
      tracker.captureMessage("hi");
      expect(reports[0]!.level).toBe("info");
    } finally {
      tracker.uninstall();
    }
  });
});

describe("Global hook installation — Node", () => {
  it("install() registers process.on('uncaughtException') when configured", () => {
    const before = process.listenerCount("uncaughtException");
    const { tracker } = makeTracker({ onUncaughtException: true });
    try {
      expect(process.listenerCount("uncaughtException")).toBe(before + 1);
    } finally {
      tracker.uninstall();
      expect(process.listenerCount("uncaughtException")).toBe(before);
    }
  });

  it("install() registers process.on('unhandledRejection') when configured", () => {
    const before = process.listenerCount("unhandledRejection");
    const { tracker } = makeTracker({ onUnhandledRejection: true });
    try {
      expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
    } finally {
      tracker.uninstall();
      expect(process.listenerCount("unhandledRejection")).toBe(before);
    }
  });

  it("install() does NOT install an XHR wrap (no XHR in Node)", () => {
    // There's no `wrapXhr` field on ErrorCaptureConfig — the very fact
    // that it's not in the type system is the assertion. This test
    // verifies the type-level guarantee at runtime by checking that
    // `XMLHttpRequest` is not patched after install.
    const before = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
    const { tracker } = makeTracker({ wrapFetch: true });
    try {
      expect((globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest).toBe(before);
    } finally {
      tracker.uninstall();
    }
  });

  it("uninstall() removes process listeners (idempotent install/uninstall)", () => {
    const before = process.listenerCount("uncaughtException");
    const { tracker } = makeTracker({ onUncaughtException: true });
    tracker.uninstall();
    expect(process.listenerCount("uncaughtException")).toBe(before);
  });

  it("install() is idempotent — second call is a no-op", () => {
    const { tracker } = makeTracker({ onUncaughtException: true });
    const after1 = process.listenerCount("uncaughtException");
    try {
      tracker.install(); // second call
      expect(process.listenerCount("uncaughtException")).toBe(after1);
    } finally {
      tracker.uninstall();
    }
  });

  it("handlersInstalled getter reports whether install() ran", () => {
    const { tracker } = makeTracker({ onUncaughtException: true });
    try {
      expect(tracker.handlersInstalled).toBe(true);
      tracker.uninstall();
      expect(tracker.handlersInstalled).toBe(false);
    } finally {
      tracker.uninstall();
    }
  });
});

describe("Fetch wrap — error.http capture", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("5xx response captured as error.http with status, method, url", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("err", { status: 500, statusText: "Server Error" }));
    const { tracker, reports } = makeTracker({ wrapFetch: true });
    try {
      await globalThis.fetch("https://example.com/api");
      expect(reports).toHaveLength(1);
      expect(reports[0]!.kind).toBe("error.http");
      expect(reports[0]!.http).toMatchObject({ url: "https://example.com/api", status: 500 });
    } finally {
      tracker.uninstall();
    }
  });

  it("network failure captured as error.http with status: 0", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const { tracker, reports } = makeTracker({ wrapFetch: true });
    try {
      await expect(globalThis.fetch("https://example.com/api")).rejects.toThrow();
      expect(reports).toHaveLength(1);
      expect(reports[0]!.kind).toBe("error.http");
      expect(reports[0]!.http?.status).toBe(0);
    } finally {
      tracker.uninstall();
    }
  });

  it("self-skip: requests to the configured selfHostname are NEVER captured", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("err", { status: 500 }));
    const { tracker, reports } = makeTracker(
      { wrapFetch: true },
      { selfHostname: "api.cross-deck.com" },
    );
    try {
      await globalThis.fetch("https://api.cross-deck.com/v1/events");
      expect(reports).toHaveLength(0);
    } finally {
      tracker.uninstall();
    }
  });

  it("self-skip honours a CUSTOM baseUrl-derived hostname (P0 #7 regression)", async () => {
    // Pre-fix the skip was hardcoded to "api.cross-deck.com" — any
    // customer pointing the SDK at a regional / staging / self-hosted
    // base URL recursed: SDK 5xx → captureHttp → enqueue → /events →
    // captureHttp → ∞. Post-fix the skip is derived from the
    // configured baseUrl at construction time.
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("err", { status: 503 }));
    const { tracker, reports } = makeTracker(
      { wrapFetch: true },
      { selfHostname: "api-eu.crossdeck-relay.internal" },
    );
    try {
      await globalThis.fetch("https://api-eu.crossdeck-relay.internal/v1/events");
      expect(reports).toHaveLength(0);
    } finally {
      tracker.uninstall();
    }
  });

  it("self-skip is hostname-strict (no substring match — attacker.example carrying our host as a prefix is captured)", async () => {
    // `url.includes("api.cross-deck.com")` would have falsely matched
    // `https://api.cross-deck.com.attacker.example/...`. The new
    // implementation parses the URL and compares hostname strictly.
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("err", { status: 502 }));
    const { tracker, reports } = makeTracker(
      { wrapFetch: true },
      { selfHostname: "api.cross-deck.com" },
    );
    try {
      await globalThis.fetch("https://api.cross-deck.com.attacker.example/v1/events");
      expect(reports).toHaveLength(1);
      expect(reports[0]!.http?.url).toBe("https://api.cross-deck.com.attacker.example/v1/events");
    } finally {
      tracker.uninstall();
    }
  });

  it("self-skip is case-insensitive on hostname", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("err", { status: 500 }));
    const { tracker, reports } = makeTracker(
      { wrapFetch: true },
      { selfHostname: "api.cross-deck.com" }, // lowercased at extraction time
    );
    try {
      await globalThis.fetch("https://API.Cross-Deck.COM/v1/events");
      expect(reports).toHaveLength(0);
    } finally {
      tracker.uninstall();
    }
  });

  it("with NO selfHostname configured, every request (including api.cross-deck.com) is captured", async () => {
    // Default: tests that don't supply selfHostname (most do today).
    // Captures everything. This is the safe fall-through: better to
    // capture a Crossdeck-own 5xx than swallow a customer's real 5xx
    // because of a config typo.
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("err", { status: 500 }));
    const { tracker, reports } = makeTracker({ wrapFetch: true });
    try {
      await globalThis.fetch("https://api.cross-deck.com/v1/events");
      expect(reports).toHaveLength(1);
    } finally {
      tracker.uninstall();
    }
  });

  it("4xx responses are NOT captured (often expected — auth required, validation failed)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    const { tracker, reports } = makeTracker({ wrapFetch: true });
    try {
      await globalThis.fetch("https://example.com/api");
      expect(reports).toHaveLength(0);
    } finally {
      tracker.uninstall();
    }
  });

  it("uninstall() restores the original fetch when no later wrapper layered on top", async () => {
    const sentinel = globalThis.fetch;
    const { tracker } = makeTracker({ wrapFetch: true });
    expect(globalThis.fetch).not.toBe(sentinel);
    tracker.uninstall();
    expect(globalThis.fetch).toBe(sentinel);
  });
});

describe("Filtering + sampling + rate limit", () => {
  it("ignoreErrors string match drops the report", () => {
    const { tracker, reports } = makeTracker({ ignoreErrors: ["expected-noise"] });
    try {
      tracker.captureError(new Error("this is expected-noise we ignore"));
      tracker.captureError(new Error("genuine bug"));
      expect(reports).toHaveLength(1);
      expect(reports[0]!.message).toBe("genuine bug");
    } finally {
      tracker.uninstall();
    }
  });

  it("ignoreErrors RegExp match drops the report", () => {
    const { tracker, reports } = makeTracker({ ignoreErrors: [/^noise:/] });
    try {
      tracker.captureError(new Error("noise: skipped"));
      tracker.captureError(new Error("real error"));
      expect(reports).toHaveLength(1);
      expect(reports[0]!.message).toBe("real error");
    } finally {
      tracker.uninstall();
    }
  });

  it("denyPaths regex matches against the top-frame filename and drops", () => {
    // Build a CapturedError with a frame in node_modules/@cross-deck/node
    // via captureError of a manufactured Error with a forged stack.
    const err = new Error("self-error");
    err.stack = `Error: self-error\n    at SDK.method (/app/node_modules/@cross-deck/node/dist/index.cjs:42:1)`;
    const { tracker, reports } = makeTracker(); // denyPaths default includes @cross-deck/node
    try {
      tracker.captureError(err);
      // Stack parser marks the @cross-deck/node frame as not in_app, so
      // it's excluded from the fingerprint. The frames array still has
      // it; passesPathGate checks against the top frame's filename.
      // Either way: the report is dropped because the only frame is in
      // the denied path.
      expect(reports).toHaveLength(0);
    } finally {
      tracker.uninstall();
    }
  });

  it("allowPaths filter requires at least one match when non-empty", () => {
    const err = new Error("app-error");
    err.stack = `Error: app-error\n    at App.handle (/app/src/handler.js:10:5)`;
    const { tracker, reports } = makeTracker({
      allowPaths: [/forbidden-prefix/],
      denyPaths: [],
    });
    try {
      tracker.captureError(err);
      expect(reports).toHaveLength(0);
    } finally {
      tracker.uninstall();
    }
  });

  it("sampleRate < 1 — fingerprint with leading byte > sampleRate × 255 is dropped", () => {
    // Deterministic: the fingerprint for a specific message-and-no-frames
    // input is stable across runs. We pick a sampleRate of 0 to drop ALL.
    const { tracker, reports } = makeTracker({ sampleRate: 0 });
    try {
      tracker.captureError(new Error("any"));
      expect(reports).toHaveLength(0);
    } finally {
      tracker.uninstall();
    }
  });

  it("sampleRate = 1 always sends", () => {
    const { tracker, reports } = makeTracker({ sampleRate: 1 });
    try {
      for (let i = 0; i < 5; i++) tracker.captureError(new Error(`unique-${i}`));
      expect(reports.length).toBe(5);
    } finally {
      tracker.uninstall();
    }
  });

  it("maxPerFingerprintPerMinute (default 5) caps per-fingerprint reports", () => {
    const { tracker, reports } = makeTracker({ maxPerFingerprintPerMinute: 2 });
    try {
      // Same message + same (empty) frames → same fingerprint.
      for (let i = 0; i < 5; i++) tracker.captureError("same fingerprint");
      expect(reports.length).toBe(2);
    } finally {
      tracker.uninstall();
    }
  });

  it("maxPerSession hard-caps total reports per process", () => {
    const { tracker, reports } = makeTracker({ maxPerSession: 3 });
    try {
      for (let i = 0; i < 10; i++) tracker.captureError(new Error(`unique-${i}`));
      expect(reports.length).toBe(3);
    } finally {
      tracker.uninstall();
    }
  });
});

describe("beforeSend hook", () => {
  it("beforeSend returning null drops the report", () => {
    let beforeSend: ((err: CapturedError) => CapturedError | null) | null = () => null;
    const reports: CapturedError[] = [];
    const tracker = new ErrorTracker({
      config: { ...DEFAULT_ERROR_CAPTURE, onUncaughtException: false, onUnhandledRejection: false, wrapFetch: false },
      breadcrumbs: new BreadcrumbBuffer(),
      report: (e: CapturedError) => reports.push(e),
      getContext: () => ({}),
      getTags: () => ({}),
      isConsented: () => true,
      beforeSend: () => beforeSend,
    });
    tracker.install();
    try {
      tracker.captureError(new Error("boom"));
      expect(reports).toHaveLength(0);
    } finally {
      tracker.uninstall();
    }
  });

  it("beforeSend returning a modified CapturedError sends the modified version", () => {
    let beforeSend: ((err: CapturedError) => CapturedError | null) | null = (err) => ({
      ...err,
      message: "[scrubbed]",
    });
    const reports: CapturedError[] = [];
    const tracker = new ErrorTracker({
      config: { ...DEFAULT_ERROR_CAPTURE, onUncaughtException: false, onUnhandledRejection: false, wrapFetch: false },
      breadcrumbs: new BreadcrumbBuffer(),
      report: (e: CapturedError) => reports.push(e),
      getContext: () => ({}),
      getTags: () => ({}),
      isConsented: () => true,
      beforeSend: () => beforeSend,
    });
    tracker.install();
    try {
      tracker.captureError(new Error("token=abc"));
      expect(reports[0]!.message).toBe("[scrubbed]");
    } finally {
      tracker.uninstall();
    }
  });

  it("a throwing beforeSend falls back to the original report (never swallows)", () => {
    let beforeSend: ((err: CapturedError) => CapturedError | null) | null = () => {
      throw new Error("hook crashed");
    };
    const reports: CapturedError[] = [];
    const tracker = new ErrorTracker({
      config: { ...DEFAULT_ERROR_CAPTURE, onUncaughtException: false, onUnhandledRejection: false, wrapFetch: false },
      breadcrumbs: new BreadcrumbBuffer(),
      report: (e: CapturedError) => reports.push(e),
      getContext: () => ({}),
      getTags: () => ({}),
      isConsented: () => true,
      beforeSend: () => beforeSend,
    });
    tracker.install();
    try {
      tracker.captureError(new Error("original"));
      expect(reports).toHaveLength(1);
      expect(reports[0]!.message).toBe("original");
    } finally {
      tracker.uninstall();
    }
  });
});

describe("Defensive design", () => {
  it("the tracker NEVER throws — every callback wrapped in try/swallow", () => {
    const tracker = new ErrorTracker({
      config: { ...DEFAULT_ERROR_CAPTURE, onUncaughtException: false, onUnhandledRejection: false, wrapFetch: false },
      breadcrumbs: new BreadcrumbBuffer(),
      report: () => {
        throw new Error("report callback bug");
      },
      getContext: () => ({}),
      getTags: () => ({}),
      isConsented: () => true,
    });
    tracker.install();
    try {
      // The report callback is buggy. captureError must still not throw.
      expect(() => tracker.captureError(new Error("boom"))).not.toThrow();
    } finally {
      tracker.uninstall();
    }
  });

  it("breadcrumbs from manual add are attached to subsequent error reports", () => {
    const { tracker, reports, breadcrumbs } = makeTracker();
    try {
      breadcrumbs.add({ timestamp: Date.now(), category: "custom", message: "step-1" });
      breadcrumbs.add({ timestamp: Date.now(), category: "custom", message: "step-2" });
      tracker.captureError(new Error("boom"));
      expect(reports[0]!.breadcrumbs).toHaveLength(2);
      expect(reports[0]!.breadcrumbs[0]!.message).toBe("step-1");
    } finally {
      tracker.uninstall();
    }
  });

  it("reportedCount + fingerprintsTracked getters reflect runtime state", () => {
    const { tracker } = makeTracker();
    try {
      expect(tracker.reportedCount).toBe(0);
      expect(tracker.fingerprintsTracked).toBe(0);
      tracker.captureError(new Error("a"));
      tracker.captureError(new Error("b"));
      expect(tracker.reportedCount).toBe(2);
      expect(tracker.fingerprintsTracked).toBe(2);
    } finally {
      tracker.uninstall();
    }
  });

  it("captureError fingerprints are stable across calls with the same message", () => {
    const { tracker, reports } = makeTracker();
    try {
      tracker.captureError("same");
      tracker.captureError("same");
      expect(reports).toHaveLength(2);
      expect(reports[0]!.fingerprint).toBe(reports[1]!.fingerprint);
    } finally {
      tracker.uninstall();
    }
  });
});

describe("Memory bound — fingerprint window does not grow unboundedly", () => {
  it("Map bounded under MAX_FINGERPRINTS_TRACKED after many unique fingerprints", () => {
    // Run a session with maxPerSession set high enough to let all
    // unique fingerprints through, but with the natural cap on the
    // tracker's internal Map kicking in beyond 4096.
    const { tracker } = makeTracker({
      maxPerSession: 10_000,
      maxPerFingerprintPerMinute: 100,
    });
    try {
      // Fire 5,000 unique error messages — each gets a fresh fingerprint.
      for (let i = 0; i < 5_000; i++) {
        tracker.captureError(`unique-${i}`);
      }
      // The internal Map should NOT have all 5,000 entries — pruning
      // happens opportunistically when the cap is exceeded. The
      // public getter `fingerprintsTracked` is what we assert.
      expect(tracker.fingerprintsTracked).toBeLessThanOrEqual(4_096);
    } finally {
      tracker.uninstall();
    }
  });
});

// ============================================================
// Self-skip URL matching (P0 #7) — unit tests for the pure
// extractSelfHostname() + isSelfRequest() helpers. End-to-end
// wrap-firing assertions live in the "Fetch wrap — error.http
// capture" describe block above; the pure-function tests below
// exhaustively cover the matching logic that pre-fix was a
// `url.includes("api.cross-deck.com")` hardcode.
// ============================================================

describe("extractSelfHostname (P0 #7)", () => {
  it("returns the lowercased hostname from a https URL", () => {
    expect(extractSelfHostname("https://api.cross-deck.com/v1")).toBe("api.cross-deck.com");
  });

  it("lowercases mixed-case hostnames", () => {
    expect(extractSelfHostname("https://API.Cross-Deck.COM/v1")).toBe("api.cross-deck.com");
  });

  it("works with a custom baseUrl (regional / staging / self-hosted relay)", () => {
    expect(extractSelfHostname("https://crossdeck-eu.customer.example/v1")).toBe(
      "crossdeck-eu.customer.example",
    );
    expect(extractSelfHostname("https://api-staging.cross-deck.com/v1")).toBe(
      "api-staging.cross-deck.com",
    );
  });

  it("returns null on malformed input", () => {
    expect(extractSelfHostname("not-a-url")).toBeNull();
    expect(extractSelfHostname("")).toBeNull();
    expect(extractSelfHostname(undefined)).toBeNull();
    expect(extractSelfHostname(null)).toBeNull();
  });
});

describe("isSelfRequest (P0 #7)", () => {
  it("returns true when the request hostname matches", () => {
    expect(isSelfRequest("https://api.cross-deck.com/v1/events", "api.cross-deck.com")).toBe(true);
  });

  it("returns true on a CUSTOM baseUrl-derived hostname (regional / staging / self-hosted)", () => {
    expect(
      isSelfRequest(
        "https://crossdeck-eu.customer.example/v1/events",
        "crossdeck-eu.customer.example",
      ),
    ).toBe(true);
  });

  it("is case-insensitive on the request hostname", () => {
    expect(isSelfRequest("https://API.Cross-Deck.COM/v1/events", "api.cross-deck.com")).toBe(true);
  });

  it("is hostname-STRICT — substring matches do NOT count (attacker.example with our host as a prefix)", () => {
    expect(
      isSelfRequest("https://api.cross-deck.com.attacker.example/v1/events", "api.cross-deck.com"),
    ).toBe(false);
    expect(isSelfRequest("https://evil-api.cross-deck.com/x", "api.cross-deck.com")).toBe(false);
  });

  it("returns false on a non-matching hostname", () => {
    expect(isSelfRequest("https://example.com/v1/events", "api.cross-deck.com")).toBe(false);
    expect(isSelfRequest("https://api.stripe.com/v1/charges", "api.cross-deck.com")).toBe(false);
  });

  it("returns false when selfHostname is null / undefined (safe fall-through)", () => {
    expect(isSelfRequest("https://api.cross-deck.com/v1/events", null)).toBe(false);
    expect(isSelfRequest("https://api.cross-deck.com/v1/events", undefined)).toBe(false);
  });

  it("returns false on a malformed request URL (SDK only ever uses absolute URLs)", () => {
    expect(isSelfRequest("not-a-url", "api.cross-deck.com")).toBe(false);
    expect(isSelfRequest("", "api.cross-deck.com")).toBe(false);
    expect(isSelfRequest("/relative/path", "api.cross-deck.com")).toBe(false);
  });
});
