/**
 * Error capture — the third Crossdeck USP, the headline reason backend
 * developers install observability SDKs.
 *
 * Catches every error source a Node process can hand us and ships them
 * as Crossdeck events. The pipeline reuses the analytics queue:
 *   - Same retry-with-backoff + Idempotency-Key (duplicate batches
 *     dedup server-side)
 *   - Same property sanitisation (one bad context blob can't poison
 *     the batch)
 *   - Same on-the-wire enrichment via runtime-info
 *
 * Error sources captured (each toggleable):
 *   1. `process.on('uncaughtException')`  — uncaught synchronous errors
 *   2. `process.on('unhandledRejection')` — unhandled promise rejections
 *   3. `globalThis.fetch` wrap            — 5xx + network failures
 *   4. `console.error` wrap (default OFF) — noisy, opt-in
 *   5. `server.captureError(err)`         — manual try/catch API
 *   6. `server.captureMessage(msg)`       — non-error signals
 *
 * Adapted from `@cross-deck/web/src/error-capture.ts`. Three runtime
 * differences:
 *   - `window.onerror` → `process.on('uncaughtException')`. Node's
 *     uncaught-exception handler receives an `Error` directly, not an
 *     `ErrorEvent` wrapper — `buildFromUnknown` handles both.
 *   - `window.onunhandledrejection` → `process.on('unhandledRejection')`.
 *     Same shape (the rejection's `reason`); same handler logic.
 *   - `XMLHttpRequest` wrap → dropped (no XHR in Node).
 *
 * Defensive design rules (parity with web):
 *   - The error handler must NEVER throw — if our own code crashed
 *     while reporting an error, we'd take down the host's last-resort
 *     error path. Every callback wrapped in try/swallow.
 *   - Recursion guard: a `_reporting` flag prevents reporting our own
 *     errors recursively forever.
 *   - Rate limited per-fingerprint: max N reports per minute to defend
 *     against runaway loops (e.g. an error in a per-request middleware).
 *   - Session cap (per process lifetime): hard limit after which we
 *     stop reporting. The dashboard sees "1 unique error" instead of
 *     a million events.
 *   - Self-skip for `api.cross-deck.com` requests so a Crossdeck
 *     outage doesn't self-amplify back into the queue.
 */

import { parseStack, fingerprintError, type StackFrame } from "./stack-parser";
import type { BreadcrumbBuffer, Breadcrumb } from "./breadcrumbs";
import type { ErrorLevel } from "./types";

export type { ErrorLevel };

export interface CapturedError {
  /** When the error fired (epoch ms). */
  timestamp: number;
  /** error.unhandled | error.unhandledrejection | error.handled | error.message | error.http */
  kind:
    | "error.unhandled"
    | "error.unhandledrejection"
    | "error.handled"
    | "error.message"
    | "error.http";
  level: ErrorLevel;
  message: string;
  /** The error class name when we have it (TypeError, ReferenceError, etc.) */
  errorType: string | null;
  /** Parsed stack frames, empty when unavailable. */
  frames: StackFrame[];
  /** Raw stack string for fallback display. */
  rawStack: string | null;
  /** djb2 hash of message + top frames — groups identical errors. */
  fingerprint: string;
  /** Snapshot of the breadcrumb buffer at the moment the error fired. */
  breadcrumbs: Breadcrumb[];
  /** Free-form context attached via `server.setContext()`. */
  context: Record<string, unknown>;
  /** Free-form tags attached via `server.setTag()`. */
  tags: Record<string, string>;
  /** Set only on `error.http` — the request that failed. */
  http?: {
    url: string;
    method: string;
    status: number;
    statusText?: string;
  };
}

export interface ErrorCaptureConfig {
  /** Master switch. Default true. */
  enabled: boolean;
  /** Hook `process.on('uncaughtException')`. Default true. */
  onUncaughtException: boolean;
  /** Hook `process.on('unhandledRejection')`. Default true. */
  onUnhandledRejection: boolean;
  /** Wrap `globalThis.fetch` to capture 5xx + network failures. Default true. */
  wrapFetch: boolean;
  /** Wrap `console.error`. Default false (noisy). */
  captureConsole: boolean;
  /**
   * Drop errors matching these substrings / regexes. Tested against
   * `message`. Default: empty (Node has no equivalent of the
   * browser's `ResizeObserver` / `Script error.` noise).
   */
  ignoreErrors: Array<string | RegExp>;
  /**
   * Only capture errors whose top in-app frame filename matches one
   * of these. Empty array means "no allowlist — capture everything".
   */
  allowPaths: Array<string | RegExp>;
  /**
   * Drop errors whose top frame filename matches any of these.
   * Default: SDK self-skip pattern (`@cross-deck/node`).
   */
  denyPaths: Array<string | RegExp>;
  /**
   * Sample rate, 0–1. 1.0 = send every error. 0.5 = send half (per
   * fingerprint, deterministically — so a given fingerprint always
   * either always sends or never does, no flapping). Default 1.0.
   */
  sampleRate: number;
  /**
   * Maximum errors per fingerprint per minute. Defends against
   * runaway loops. Default 5.
   */
  maxPerFingerprintPerMinute: number;
  /**
   * Total cap per process lifetime, regardless of fingerprint. Hard
   * limit after which we stop reporting. Default 100.
   */
  maxPerSession: number;
}

export const DEFAULT_ERROR_CAPTURE: ErrorCaptureConfig = {
  enabled: true,
  onUncaughtException: true,
  onUnhandledRejection: true,
  wrapFetch: true,
  captureConsole: false,
  ignoreErrors: [],
  allowPaths: [],
  denyPaths: [
    // SDK self-skip — caught by stack-parser's `isInAppFrame` too,
    // but defensive here in case a future change to the heuristic
    // misses one of these paths.
    /[\\/]node_modules[\\/]@cross-deck[\\/]node[\\/]/,
  ],
  sampleRate: 1.0,
  maxPerFingerprintPerMinute: 5,
  maxPerSession: 100,
};

export interface ErrorTrackerOptions {
  config: ErrorCaptureConfig;
  breadcrumbs: BreadcrumbBuffer;
  /** Called with each captured error. Forwards into the event queue. */
  report: (err: CapturedError) => void;
  /** Called to read the current developer-supplied context bag. */
  getContext: () => Record<string, unknown>;
  /** Called to read the current developer-supplied tag bag. */
  getTags: () => Record<string, string>;
  /**
   * Pre-send hook. Return null to drop, or a modified version to
   * scrub fields. Called LAST, after rate limit + sampling have
   * already passed.
   */
  beforeSend?: ((err: CapturedError) => CapturedError | null) | null;
  /**
   * Whether the consent dimension `errors` is currently granted. The
   * Node SDK doesn't ship a ConsentManager (server-side trust model
   * — the caller decides), so this is typically `() => true`. We keep
   * the hook so callers who DO want a kill switch (e.g. a config
   * flag to disable error reporting in CI) have a place to wire it.
   */
  isConsented: () => boolean;
}

/**
 * Cap on the size of the per-fingerprint rate-limit window Map. A
 * long-running process firing many unique fingerprints would
 * otherwise leak Map entries forever. When the Map exceeds this
 * size, dead entries (empty windows) are pruned; if pruning doesn't
 * release enough space, the oldest entries are evicted FIFO. 4096
 * unique error fingerprints is well above realistic per-minute
 * cardinality on production servers.
 */
const MAX_FINGERPRINTS_TRACKED = 4096;
const FINGERPRINT_WINDOW_MS = 60_000;

export class ErrorTracker {
  private installed = false;
  private cleanups: Array<() => void> = [];
  private _reporting = false;
  private sessionCount = 0;
  private fingerprintWindow = new Map<string, number[]>();

  constructor(private readonly opts: ErrorTrackerOptions) {}

  install(): void {
    if (this.installed) return;
    if (!this.opts.config.enabled) return;

    if (this.opts.config.onUncaughtException) this.installUncaughtExceptionHandler();
    if (this.opts.config.onUnhandledRejection) this.installUnhandledRejectionHandler();
    if (this.opts.config.wrapFetch) this.installFetchWrap();
    if (this.opts.config.captureConsole) this.installConsoleWrap();

    this.installed = true;
  }

  uninstall(): void {
    for (const fn of this.cleanups.splice(0)) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
    this.installed = false;
  }

  /**
   * Manual API. Either an Error instance or any unknown value (we
   * coerce). Returns silently — never throws, even if the SDK isn't
   * initialised.
   */
  captureError(
    error: unknown,
    options?: { context?: Record<string, unknown>; tags?: Record<string, string>; level?: ErrorLevel },
  ): void {
    if (!this.opts.isConsented()) return;
    try {
      const captured = this.buildFromUnknown(error, "error.handled", options?.level ?? "error");
      if (options?.context) captured.context = { ...captured.context, ...options.context };
      if (options?.tags) captured.tags = { ...captured.tags, ...options.tags };
      this.maybeReport(captured);
    } catch {
      // self-protection — never let our own code crash the caller's
      // error handler.
    }
  }

  /**
   * Capture a non-error event as an issue. For "we hit a soft-warning
   * code path" / "deprecated API used" kinds of signals. Pairs with
   * Sentry's captureMessage().
   */
  captureMessage(message: string, level: ErrorLevel = "info"): void {
    if (!this.opts.isConsented()) return;
    try {
      const captured: CapturedError = {
        timestamp: Date.now(),
        kind: "error.message",
        level,
        message,
        errorType: null,
        frames: [],
        rawStack: null,
        fingerprint: fingerprintError(message, []),
        breadcrumbs: this.opts.breadcrumbs.snapshot(),
        context: this.opts.getContext(),
        tags: this.opts.getTags(),
      };
      this.maybeReport(captured);
    } catch {
      // swallow
    }
  }

  /** Inspection hook — total reports captured this process lifetime. */
  get reportedCount(): number {
    return this.sessionCount;
  }

  /** Inspection hook — number of distinct fingerprints inside the rate-limit window. */
  get fingerprintsTracked(): number {
    return this.fingerprintWindow.size;
  }

  /** Inspection hook — whether global handlers are installed. */
  get handlersInstalled(): boolean {
    return this.installed;
  }

  // ============================================================
  // Listener installation — Node hooks
  // ============================================================

  private installUncaughtExceptionHandler(): void {
    const handler = (err: Error): void => {
      if (this._reporting) return;
      if (!this.opts.isConsented()) return;
      try {
        this._reporting = true;
        const captured = this.buildFromUnknown(err, "error.unhandled", "error");
        this.maybeReport(captured);
      } catch {
        // swallow
      } finally {
        this._reporting = false;
      }
    };
    process.on("uncaughtException", handler);
    this.cleanups.push(() => process.off("uncaughtException", handler));
  }

  private installUnhandledRejectionHandler(): void {
    // Node's `unhandledRejection` handler receives `(reason, promise)`.
    // The reason is whatever was passed to `reject()` — typically an
    // Error, but can be any value. `buildFromUnknown` handles both.
    const handler = (reason: unknown): void => {
      if (this._reporting) return;
      if (!this.opts.isConsented()) return;
      try {
        this._reporting = true;
        const captured = this.buildFromUnknown(reason, "error.unhandledrejection", "error");
        this.maybeReport(captured);
      } catch {
        // swallow
      } finally {
        this._reporting = false;
      }
    };
    process.on("unhandledRejection", handler);
    this.cleanups.push(() => process.off("unhandledRejection", handler));
  }

  /**
   * Wrap `globalThis.fetch` so failed HTTP requests get auto-captured.
   * We do NOT call 4xx an "error" (those are often expected — auth
   * required, validation failed). Only 5xx + network failures fire.
   *
   * Node 18+ exposes `fetch` natively on `globalThis`. We tolerate
   * its absence (some sandboxed runtimes / patched globals) by
   * skipping the wrap rather than throwing.
   */
  private installFetchWrap(): void {
    const origFetch = globalThis.fetch;
    if (typeof origFetch !== "function") return;
    const tracker = this;
    const wrapped: typeof fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const input = args[0];
      const init = args[1] ?? {};
      const url = typeof input === "string" ? input : (input as Request)?.url ?? "";
      const method = (init.method || "GET").toUpperCase();
      const start = Date.now();

      tracker.opts.breadcrumbs.add({
        timestamp: start,
        category: "http",
        message: `${method} ${url}`,
        data: { url, method },
      });

      try {
        const response = await origFetch(...args);
        if (response.status >= 500 && tracker.opts.isConsented()) {
          // Self-skip Crossdeck's own API to avoid the cycle where a
          // Crossdeck outage reports the outage to Crossdeck.
          if (!url.includes("api.cross-deck.com")) {
            tracker.captureHttp({
              url,
              method,
              status: response.status,
              statusText: response.statusText,
            });
          }
        }
        return response;
      } catch (err) {
        // Genuine network failure (DNS, connection refused, ECONNRESET).
        if (tracker.opts.isConsented() && !url.includes("api.cross-deck.com")) {
          tracker.captureHttp({
            url,
            method,
            status: 0,
            statusText: err instanceof Error ? err.message : "network error",
          });
        }
        throw err;
      }
    };
    globalThis.fetch = wrapped;
    this.cleanups.push(() => {
      // Restore only if we're still the active wrapper. Another
      // observability tool installed AFTER us would have replaced
      // `globalThis.fetch`; we don't want to unwind their patch.
      if (globalThis.fetch === wrapped) globalThis.fetch = origFetch;
    });
  }

  private installConsoleWrap(): void {
    const orig = console.error.bind(console);
    const tracker = this;
    console.error = (...args: unknown[]): void => {
      try {
        if (tracker.opts.isConsented()) {
          tracker.captureMessage(args.map((a) => safeStringify(a)).join(" "), "error");
        }
      } catch {
        // swallow
      }
      return orig(...args);
    };
    this.cleanups.push(() => {
      console.error = orig;
    });
  }

  // ============================================================
  // Builders
  // ============================================================

  /**
   * Build a `CapturedError` from any value. Handles:
   *   - Error instances (the common case) — parses `err.stack` into
   *     frames, fingerprints over message + top in-app frames.
   *   - Non-Error rejections (promise rejected with a string / number
   *     / plain object) — coerces via `safeStringify`, no frames.
   *
   * Verbatim port of web's `buildFromUnknown` — the logic is
   * runtime-agnostic.
   */
  private buildFromUnknown(
    err: unknown,
    kind: CapturedError["kind"],
    level: ErrorLevel,
  ): CapturedError {
    if (err instanceof Error) {
      const frames = parseStack(err.stack);
      return {
        timestamp: Date.now(),
        kind,
        level,
        message: String(err.message).slice(0, 1024),
        errorType: err.name,
        frames,
        rawStack: err.stack ?? null,
        fingerprint: fingerprintError(err.message, frames),
        breadcrumbs: this.opts.breadcrumbs.snapshot(),
        context: this.opts.getContext(),
        tags: this.opts.getTags(),
      };
    }
    const message = safeStringify(err).slice(0, 1024);
    return {
      timestamp: Date.now(),
      kind,
      level,
      message,
      errorType: null,
      frames: [],
      rawStack: null,
      fingerprint: fingerprintError(message, []),
      breadcrumbs: this.opts.breadcrumbs.snapshot(),
      context: this.opts.getContext(),
      tags: this.opts.getTags(),
    };
  }

  private captureHttp(info: {
    url: string;
    method: string;
    status: number;
    statusText?: string;
  }): void {
    try {
      const message = `HTTP ${info.status} ${info.method} ${info.url}`;
      const captured: CapturedError = {
        timestamp: Date.now(),
        kind: "error.http",
        level: "error",
        message,
        errorType: "HTTPError",
        frames: [],
        rawStack: null,
        fingerprint: fingerprintError(`HTTP ${info.status} ${info.method}`, []),
        breadcrumbs: this.opts.breadcrumbs.snapshot(),
        context: this.opts.getContext(),
        tags: this.opts.getTags(),
        http: info,
      };
      this.maybeReport(captured);
    } catch {
      // swallow
    }
  }

  // ============================================================
  // Reporting pipeline — filter / sample / rate-limit / send
  // ============================================================

  private maybeReport(err: CapturedError): void {
    if (this.sessionCount >= this.opts.config.maxPerSession) return;
    if (this.shouldIgnore(err)) return;
    if (!this.passesPathGate(err)) return;
    if (!this.passesSample(err)) return;
    if (!this.passesRateLimit(err)) return;

    // beforeSend hook — last chance to scrub or drop.
    let finalErr: CapturedError | null = err;
    if (this.opts.beforeSend) {
      try {
        finalErr = this.opts.beforeSend(err);
      } catch {
        // A buggy beforeSend hook must NOT swallow the error report.
        // Fall back to the original.
        finalErr = err;
      }
      if (!finalErr) return;
    }

    this.sessionCount += 1;
    try {
      this.opts.report(finalErr);
    } catch {
      // swallow — report() failure is best-effort; the next error
      // attempt will retry through the same queue.
    }
  }

  private shouldIgnore(err: CapturedError): boolean {
    for (const pat of this.opts.config.ignoreErrors) {
      if (typeof pat === "string" && err.message.includes(pat)) return true;
      if (pat instanceof RegExp && pat.test(err.message)) return true;
    }
    return false;
  }

  private passesPathGate(err: CapturedError): boolean {
    // Check the top frame's filename (best-effort — many error.http
    // events have no frames). When the URL is unknown, let it
    // through.
    const topFrame = err.frames.find((f) => f.filename) ?? null;
    const path = topFrame?.filename ?? "";
    if (!path) return true;

    for (const pat of this.opts.config.denyPaths) {
      if (typeof pat === "string" && path.includes(pat)) return false;
      if (pat instanceof RegExp && pat.test(path)) return false;
    }
    if (this.opts.config.allowPaths.length > 0) {
      for (const pat of this.opts.config.allowPaths) {
        if (typeof pat === "string" && path.includes(pat)) return true;
        if (pat instanceof RegExp && pat.test(path)) return true;
      }
      return false;
    }
    return true;
  }

  private passesSample(err: CapturedError): boolean {
    if (this.opts.config.sampleRate >= 1) return true;
    if (this.opts.config.sampleRate <= 0) return false;
    // Deterministic per-fingerprint sampling — a given fingerprint
    // always either always sends or never does, no flapping.
    const hashByte = parseInt(err.fingerprint.slice(0, 2), 16);
    return hashByte / 255 < this.opts.config.sampleRate;
  }

  private passesRateLimit(err: CapturedError): boolean {
    const now = Date.now();
    const max = this.opts.config.maxPerFingerprintPerMinute;
    const arr = this.fingerprintWindow.get(err.fingerprint) ?? [];
    const fresh = arr.filter((t) => now - t < FINGERPRINT_WINDOW_MS);
    if (fresh.length >= max) {
      this.fingerprintWindow.set(err.fingerprint, fresh);
      return false;
    }
    fresh.push(now);
    this.fingerprintWindow.set(err.fingerprint, fresh);
    this.maybePruneFingerprintWindow(now);
    return true;
  }

  /**
   * Bound the fingerprint Map's memory footprint. Runs opportunistically
   * — only when the Map exceeds `MAX_FINGERPRINTS_TRACKED`. First pass:
   * delete entries whose ENTIRE window is stale (no live timestamps
   * inside the 60s window). Second pass (if still over): FIFO-evict
   * the oldest entries by Map insertion order until we're under the
   * cap. Defends against a long-running process with high-cardinality
   * fingerprints leaking memory forever.
   */
  private maybePruneFingerprintWindow(now: number): void {
    if (this.fingerprintWindow.size <= MAX_FINGERPRINTS_TRACKED) return;
    // Pass 1 — drop entries whose entire window is stale.
    for (const [fp, timestamps] of this.fingerprintWindow) {
      const hasLive = timestamps.some((t) => now - t < FINGERPRINT_WINDOW_MS);
      if (!hasLive) this.fingerprintWindow.delete(fp);
    }
    if (this.fingerprintWindow.size <= MAX_FINGERPRINTS_TRACKED) return;
    // Pass 2 — FIFO evict the oldest until under cap.
    const overflow = this.fingerprintWindow.size - MAX_FINGERPRINTS_TRACKED;
    let dropped = 0;
    for (const fp of this.fingerprintWindow.keys()) {
      if (dropped >= overflow) break;
      this.fingerprintWindow.delete(fp);
      dropped += 1;
    }
  }
}

function safeStringify(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
}
