import { CrossdeckError, makeCrossdeckError } from "./errors";
import { crossdeckErrorFromResponse } from "./errors";
import { validateEventProperties } from "./event-validation";
// Single source of truth — `_version.ts` is generated from
// package.json by `scripts/sync-sdk-versions.mjs`. A plain TypeScript
// re-export here means the runtime `Crossdeck-Sdk-Version` header
// always matches the published bundle, with zero Node-ESM JSON-import
// gotchas. Pre-fix this was a hardcoded literal that drifted from
// package.json. `--check` mode of the sync script fails CI on drift.
import { SDK_NAME, SDK_VERSION } from "./_version";
export { SDK_NAME, SDK_VERSION };

export const DEFAULT_BASE_URL = "https://api.cross-deck.com/v1";
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Pinned Crossdeck API version sent on every request as
 * `Crossdeck-Api-Version`. Forward-compat with backend evolution —
 * server-side breaking changes ship under a new version date; pinning
 * means the SDK keeps speaking the version it was built against until
 * the SDK explicitly bumps. Stripe pattern (`Stripe-Version`).
 *
 * Bump this in lockstep with backend version releases. Document the
 * deprecation policy in CHANGELOG.
 */
export const CROSSDECK_API_VERSION = "2025-01-01";

/** Default GET retry attempts. Configurable via `httpRetries.maxAttempts`. */
const DEFAULT_GET_RETRY_ATTEMPTS = 3;

/** Default statuses considered retryable on GET. 408 + 5xx (except 501 Not Implemented). */
const DEFAULT_RETRYABLE_STATUSES = new Set([408, 500, 502, 503, 504]);

export interface HttpRetriesConfig {
  /** Max attempts INCLUSIVE of the first call. Default 3 (1 initial + 2 retries). 1 disables retries. */
  maxAttempts?: number;
  /** Statuses considered retryable. Default: 408, 500, 502, 503, 504. */
  retryableStatuses?: number[];
}

export interface HttpClientConfig {
  secretKey: string;
  baseUrl: string;
  sdkVersion: string;
  timeoutMs?: number;
  /**
   * Override the runtime token in the `User-Agent` header. Default
   * detects `node/<process.versions.node>` automatically.
   */
  runtimeToken?: string;
  /**
   * Retry config for idempotent GET requests. Default: 3 attempts
   * with exponential backoff + full jitter, retrying on 408 + 5xx
   * (except 501) and on network failures. Set `maxAttempts: 1` to
   * disable retries.
   */
  httpRetries?: HttpRetriesConfig;
  /**
   * `testMode: true` short-circuits every request to a synthetic
   * success response with a benign shape. No network goes out. For
   * caller test suites that don't want to mock `globalThis.fetch`.
   * Forwarded from `CrossdeckServerOptions.testMode`.
   */
  testMode?: boolean;
  /**
   * Optional inspection hooks. Fire BEFORE/AFTER every request — used
   * for debugging, audit logging, and custom telemetry. Both must
   * return synchronously and must NOT throw (errors are swallowed,
   * the request continues).
   */
  onRequest?: (info: HttpRequestInfo) => void;
  onResponse?: (info: HttpResponseInfo) => void;
}

export interface HttpRequestInfo {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  /** The serialised body string, when one was set. */
  bodyPreview?: string;
  /** Attempt number, starting at 1. Useful for distinguishing retries. */
  attempt: number;
}

export interface HttpResponseInfo {
  method: "GET" | "POST";
  url: string;
  status: number;
  durationMs: number;
  attempt: number;
  /** True if the request was a synthetic test-mode response. */
  testMode: boolean;
}

export interface HttpRequestOptions {
  body?: unknown;
  query?: Record<string, string | undefined>;
  timeoutMs?: number;
  idempotencyKey?: string;
  /**
   * Caller-supplied AbortSignal. When aborted, the in-flight `fetch`
   * is cancelled and the call throws `CrossdeckError({ code:
   * "request_aborted" })`. Compose with the per-request timeout
   * (whichever fires first wins).
   */
  signal?: AbortSignal;
  /** Override the HTTP-retry policy for this single call. */
  retries?: HttpRetriesConfig;
}

export class HttpClient {
  private readonly userAgent: string;

  constructor(private readonly config: HttpClientConfig) {
    this.userAgent = buildUserAgent(config.sdkVersion, config.runtimeToken);
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);

    // testMode short-circuits ALL requests with a synthetic response —
    // caller test suites get a valid-shaped object back without
    // mocking `globalThis.fetch`. Honours `onRequest` / `onResponse`
    // hooks so audit pipelines see the synthetic traffic.
    if (this.config.testMode === true) {
      return this.synthesizeTestModeResponse<T>(method, path, url, options);
    }

    const headers = this.buildHeaders(options);
    const bodyInit = this.buildBody(headers, options.body);

    // Retry policy applies only to idempotent GET requests. POST
    // retries are handled by the EventQueue with batch-level
    // Idempotency-Key reuse.
    const retryCfg = options.retries ?? this.config.httpRetries ?? {};
    const maxAttempts =
      method === "GET" ? (retryCfg.maxAttempts ?? DEFAULT_GET_RETRY_ATTEMPTS) : 1;
    const retryableStatuses = retryCfg.retryableStatuses
      ? new Set(retryCfg.retryableStatuses)
      : DEFAULT_RETRYABLE_STATUSES;

    let lastError: CrossdeckError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const reqInfo: HttpRequestInfo = {
        method,
        url,
        headers,
        bodyPreview: typeof bodyInit === "string" ? bodyInit : undefined,
        attempt,
      };
      try {
        this.config.onRequest?.(reqInfo);
      } catch {
        // hooks must never break the request pipeline
      }

      const start = Date.now();
      let response: Response | null = null;
      let networkError: unknown = null;
      try {
        response = await this.dispatch(url, method, headers, bodyInit, options);
      } catch (err) {
        networkError = err;
      }

      const durationMs = Date.now() - start;

      if (response) {
        try {
          this.config.onResponse?.({
            method,
            url,
            status: response.status,
            durationMs,
            attempt,
            testMode: false,
          });
        } catch {
          // hooks must never break the response pipeline
        }
      }

      // Network error path — retry on GET if attempts remain.
      if (networkError !== null) {
        lastError = this.translateNetworkError(networkError, path, options);
        if (method === "GET" && attempt < maxAttempts) {
          await sleepWithJitter(attempt);
          continue;
        }
        throw lastError;
      }

      // Non-OK response — retry on GET for the retryable statuses,
      // else throw the typed subclass.
      if (response && !response.ok) {
        const err = await crossdeckErrorFromResponse(response);
        if (
          method === "GET" &&
          retryableStatuses.has(response.status) &&
          attempt < maxAttempts
        ) {
          lastError = err;
          await sleepForRetry(err, attempt);
          continue;
        }
        throw err;
      }

      // 2xx — return the body.
      if (response!.status === 204) return undefined as T;
      try {
        return (await response!.json()) as T;
      } catch {
        throw makeCrossdeckError({
          type: "internal_error",
          code: "invalid_json_response",
          message: "Server returned a 2xx with an unparseable body.",
          requestId: response!.headers.get("x-request-id") ?? undefined,
          status: response!.status,
        });
      }
    }

    // Unreachable in practice — the loop either returns or throws —
    // but TypeScript needs an exit. Rethrow the last seen error.
    throw lastError ?? makeCrossdeckError({
      type: "internal_error",
      code: "retry_exhausted",
      message: `GET ${path} exhausted ${maxAttempts} attempts.`,
    });
  }

  /**
   * Issue a single fetch invocation. Composes the per-request timeout
   * with the caller-supplied AbortSignal — whichever fires first wins.
   */
  private async dispatch(
    url: string,
    method: "GET" | "POST",
    headers: Record<string, string>,
    bodyInit: RequestInit["body"] | undefined,
    options: HttpRequestOptions,
  ): Promise<Response> {
    const effectiveTimeout = options.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const supportsAbort = typeof AbortController !== "undefined";
    const controller = supportsAbort && effectiveTimeout > 0 ? new AbortController() : null;

    // Chain the caller's AbortSignal into ours so an external abort
    // propagates to the in-flight fetch.
    let externalAbortHandler: (() => void) | null = null;
    if (controller && options.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        externalAbortHandler = (): void => controller.abort();
        options.signal.addEventListener("abort", externalAbortHandler, { once: true });
      }
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (controller && effectiveTimeout > 0) {
      timeoutHandle = setTimeout(() => controller.abort(), effectiveTimeout);
    }

    try {
      return await fetch(url, {
        method,
        headers,
        body: bodyInit,
        signal: controller?.signal ?? options.signal,
      });
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      if (externalAbortHandler && options.signal) {
        try {
          options.signal.removeEventListener("abort", externalAbortHandler);
        } catch {
          // ignore — signal may not support removeEventListener
        }
      }
    }
  }

  /** Build the request headers. Same across attempts so caches can dedupe. */
  private buildHeaders(options: HttpRequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.secretKey}`,
      "Crossdeck-Sdk-Version": `${SDK_NAME}@${this.config.sdkVersion}`,
      "Crossdeck-Api-Version": CROSSDECK_API_VERSION,
      "User-Agent": this.userAgent,
      Accept: "application/json",
    };
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    return headers;
  }

  private buildBody(
    headers: Record<string, string>,
    body: unknown,
  ): RequestInit["body"] | undefined {
    if (body === undefined) return undefined;
    void headers; // headers already include Content-Type from buildHeaders
    return serializeRequestBody(body);
  }

  /** Translate a thrown fetch error or abort into a typed `CrossdeckError`. */
  private translateNetworkError(
    err: unknown,
    path: string,
    options: HttpRequestOptions,
  ): CrossdeckError {
    const callerAborted =
      options.signal?.aborted === true ||
      (err instanceof Error &&
        (err.name === "AbortError" || /aborted/i.test(err.message)));
    const callerInitiated = options.signal?.aborted === true;
    return makeCrossdeckError({
      type: "network_error",
      code: callerAborted
        ? callerInitiated
          ? "request_aborted"
          : "request_timeout"
        : "fetch_failed",
      message: callerAborted
        ? callerInitiated
          ? `Request to ${path} aborted by caller AbortSignal.`
          : `Request to ${path} aborted after ${options.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : "fetch failed",
    });
  }

  /** Synthesise a benign success-shaped response for `testMode: true`. */
  private synthesizeTestModeResponse<T>(
    method: "GET" | "POST",
    path: string,
    url: string,
    options: HttpRequestOptions,
  ): T {
    try {
      this.config.onRequest?.({
        method,
        url,
        headers: this.buildHeaders(options),
        bodyPreview: options.body !== undefined ? safeStringify(options.body) : undefined,
        attempt: 1,
      });
    } catch {
      // ignore
    }
    const synth = synthForPath<T>(path);
    try {
      this.config.onResponse?.({
        method,
        url,
        status: 200,
        durationMs: 0,
        attempt: 1,
        testMode: true,
      });
    } catch {
      // ignore
    }
    return synth;
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    let url = base + cleanPath;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (typeof v === "string" && v.length > 0) params.append(k, v);
      }
      const qs = params.toString();
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    }
    return url;
  }
}

/**
 * Build the `User-Agent` header. HTTP best practice — surfaces the
 * SDK + runtime + OS to the backend's request logs without parsing
 * the bespoke `Crossdeck-Sdk-Version` (which only carries the SDK
 * name/version).
 *
 *   @cross-deck/node/1.2.0 node/20.10.0 darwin
 */
function buildUserAgent(sdkVersion: string, override?: string): string {
  if (override) return `${SDK_NAME}/${sdkVersion} ${override}`;
  const nodeVersion = typeof process !== "undefined" && process.versions ? process.versions.node : "unknown";
  const osPlatform = typeof process !== "undefined" && process.platform ? process.platform : "unknown";
  return `${SDK_NAME}/${sdkVersion} node/${nodeVersion} ${osPlatform}`;
}

/** Exponential backoff with full jitter for the GET retry path. */
async function sleepWithJitter(attempt: number): Promise<void> {
  // 50ms * 2^(attempt-1), capped at 2s, jittered to [0, ceiling].
  const ceiling = Math.min(2000, 50 * Math.pow(2, attempt - 1));
  const delay = Math.round(ceiling * Math.random());
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, delay);
    if (typeof t.unref === "function") {
      try {
        t.unref();
      } catch {
        // ignore
      }
    }
  });
}

/**
 * Sleep for the retry delay implied by a `CrossdeckError` — honours
 * server `Retry-After` when present, else falls back to jittered
 * exponential backoff.
 */
async function sleepForRetry(err: CrossdeckError, attempt: number): Promise<void> {
  if (err.retryAfterMs !== undefined && err.retryAfterMs > 0) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, err.retryAfterMs);
      if (typeof t.unref === "function") {
        try {
          t.unref();
        } catch {
          // ignore
        }
      }
    });
    return;
  }
  await sleepWithJitter(attempt);
}

/**
 * Synth response for `testMode: true`. Path-aware so each public
 * method's expected shape comes back. Keep this small + benign —
 * the goal is "caller's code path runs without surprises", not "the
 * SDK behaves identically to production."
 */
function synthForPath<T>(path: string): T {
  if (path.startsWith("/sdk/heartbeat")) {
    return {
      object: "heartbeat",
      ok: true,
      projectId: "proj_test_mode",
      appId: "app_test_mode",
      platform: "node",
      env: "sandbox",
      serverTime: Date.now(),
    } as unknown as T;
  }
  if (path.startsWith("/identity/alias")) {
    return {
      object: "alias_result",
      crossdeckCustomerId: "cdcust_test_mode",
      linked: [],
      mergePending: false,
      env: "sandbox",
    } as unknown as T;
  }
  if (path.startsWith("/identity/forget")) {
    return {
      object: "forgot",
      crossdeckCustomerId: null,
      queuedAt: Date.now(),
      env: "sandbox",
    } as unknown as T;
  }
  if (path.includes("/entitlements")) {
    return {
      object: "list",
      data: [],
      crossdeckCustomerId: "cdcust_test_mode",
      env: "sandbox",
    } as unknown as T;
  }
  if (path.startsWith("/events")) {
    return {
      object: "list",
      received: 0,
      env: "sandbox",
    } as unknown as T;
  }
  if (path.includes("/purchases/sync")) {
    return {
      object: "purchase_result",
      crossdeckCustomerId: "cdcust_test_mode",
      env: "sandbox",
      entitlements: [],
    } as unknown as T;
  }
  if (path.includes("/grant") || path.includes("/revoke")) {
    return {
      object: "entitlement_mutation",
      action: path.includes("/grant") ? "grant" : "revoke",
      crossdeckCustomerId: "cdcust_test_mode",
      entitlement: {
        object: "entitlement",
        key: "pro",
        isActive: path.includes("/grant"),
        validUntil: null,
        source: { rail: "manual", productId: "manual", subscriptionId: "manual:test_mode" },
        updatedAt: Date.now(),
      },
      env: "sandbox",
    } as unknown as T;
  }
  if (path.startsWith("/server/audit/")) {
    return {
      object: "audit_entry",
      data: {
        eventId: "audit_test_mode",
        rail: "manual",
        env: "sandbox",
        eventType: "test_mode",
        projectId: "proj_test_mode",
        decision: "applied",
        signatureVerified: true,
        reconciledWithProvider: false,
        rawEventReceivedAt: Date.now(),
        processedAt: Date.now(),
      },
    } as unknown as T;
  }
  return {} as T;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "[unserialisable]";
  }
}

function serializeRequestBody(body: unknown): string {
  try {
    const direct = JSON.stringify(body);
    if (typeof direct === "string") return direct;
  } catch {
    // Fall through to the sanitising backstop.
  }

  try {
    const wrapped = validateEventProperties(
      { __body: body },
      {
        maxStringLength: 1_000_000,
        maxBatchPropertyBytes: 10 * 1024 * 1024,
        maxDepth: 20,
      },
    ).properties.__body;
    const serialized = JSON.stringify(wrapped);
    if (typeof serialized === "string") return serialized;
  } catch {
    // Surface a stable SDK error instead of leaking the runtime's raw
    // JSON.stringify message.
  }

  throw new CrossdeckError({
    type: "invalid_request_error",
    code: "serialization_failed",
    message: "Request body could not be serialized.",
  });
}
