export type CrossdeckErrorType =
  | "authentication_error"
  | "permission_error"
  | "invalid_request_error"
  | "rate_limit_error"
  | "internal_error"
  | "network_error"
  | "configuration_error";

export interface CrossdeckErrorPayload {
  type: CrossdeckErrorType;
  /**
   * Error code. The canonical set is the `CrossdeckErrorCode` literal
   * union exported from `./error-codes` (derived from
   * `CROSSDECK_ERROR_CODES`). Typed as `string` here so the SDK can
   * still surface server-returned codes that aren't (yet) in the
   * catalogue without a wholesale recompile of every consumer.
   *
   * For type-safe code comparisons in caller code, use:
   *   `import { CrossdeckErrorCode, isCrossdeckErrorCode } from "@cross-deck/node"`
   *   `if (isCrossdeckErrorCode(err.code) && err.code === "webhook_invalid_signature") {}`
   */
  code: string;
  message: string;
  requestId?: string;
  status?: number;
  retryAfterMs?: number;
}

export class CrossdeckError extends Error {
  public readonly type: CrossdeckErrorType;
  public readonly code: string;
  public readonly requestId?: string;
  public readonly status?: number;
  public readonly retryAfterMs?: number;

  constructor(payload: CrossdeckErrorPayload) {
    super(payload.message);
    this.name = "CrossdeckError";
    this.type = payload.type;
    this.code = payload.code;
    this.requestId = payload.requestId;
    this.status = payload.status;
    this.retryAfterMs = payload.retryAfterMs;
    Object.setPrototypeOf(this, CrossdeckError.prototype);
  }

  /**
   * JSON representation suitable for structured loggers. Without this,
   * `console.log(err)` and most log frameworks (Pino, Winston) emit
   * only `name` + `message` + `stack` — losing `type`, `code`,
   * `requestId`, `status`, `retryAfterMs`. With `toJSON`, calling
   * `JSON.stringify(err)` or passing the error to a logger that
   * serialises via JSON includes the full diagnostic surface.
   *
   * Stripe pattern. Critical for production observability.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      type: this.type,
      code: this.code,
      requestId: this.requestId,
      status: this.status,
      retryAfterMs: this.retryAfterMs,
      stack: this.stack,
    };
  }
}

/**
 * Authentication failure — the secret key is missing, invalid, or
 * revoked. Maps to `type: "authentication_error"`. Includes codes:
 * `invalid_secret_key`, `webhook_invalid_signature`,
 * `webhook_replay_window_exceeded`, and any 401 from the backend.
 *
 *   if (err instanceof CrossdeckAuthenticationError) { ... }
 *
 * Stripe pattern — typed subclasses make caller error-handling
 * clean and let TypeScript narrow on `instanceof`.
 */
export class CrossdeckAuthenticationError extends CrossdeckError {
  constructor(payload: CrossdeckErrorPayload) {
    super(payload);
    this.name = "CrossdeckAuthenticationError";
    Object.setPrototypeOf(this, CrossdeckAuthenticationError.prototype);
  }
}

/**
 * Caller is authenticated but doesn't have permission for the
 * requested resource. Maps to `type: "permission_error"`.
 */
export class CrossdeckPermissionError extends CrossdeckError {
  constructor(payload: CrossdeckErrorPayload) {
    super(payload);
    this.name = "CrossdeckPermissionError";
    Object.setPrototypeOf(this, CrossdeckPermissionError.prototype);
  }
}

/**
 * Request is malformed or violates a validation rule. Maps to
 * `type: "invalid_request_error"`. Includes codes like
 * `missing_user_id`, `missing_event_name`, `serialization_failed`,
 * and any 4xx (other than 401/403/429) from the backend.
 */
export class CrossdeckValidationError extends CrossdeckError {
  constructor(payload: CrossdeckErrorPayload) {
    super(payload);
    this.name = "CrossdeckValidationError";
    Object.setPrototypeOf(this, CrossdeckValidationError.prototype);
  }
}

/**
 * Rate limit exceeded. Maps to `type: "rate_limit_error"`. Carries
 * `retryAfterMs` from the server's `Retry-After` header — caller
 * should back off and retry only after that delay.
 */
export class CrossdeckRateLimitError extends CrossdeckError {
  constructor(payload: CrossdeckErrorPayload) {
    super(payload);
    this.name = "CrossdeckRateLimitError";
    Object.setPrototypeOf(this, CrossdeckRateLimitError.prototype);
  }
}

/**
 * Network-layer failure — `fetch` threw, the request timed out, or
 * the response body was unparseable. Maps to `type: "network_error"`
 * with codes `fetch_failed`, `request_timeout`, or `internal_error`
 * (`invalid_json_response`). Almost always transient; the SDK auto-
 * retries event-queue flushes.
 */
export class CrossdeckNetworkError extends CrossdeckError {
  constructor(payload: CrossdeckErrorPayload) {
    super(payload);
    this.name = "CrossdeckNetworkError";
    Object.setPrototypeOf(this, CrossdeckNetworkError.prototype);
  }
}

/**
 * Backend returned a 5xx or the SDK detected an unexpected
 * internal state. Maps to `type: "internal_error"`.
 */
export class CrossdeckInternalError extends CrossdeckError {
  constructor(payload: CrossdeckErrorPayload) {
    super(payload);
    this.name = "CrossdeckInternalError";
    Object.setPrototypeOf(this, CrossdeckInternalError.prototype);
  }
}

/**
 * Misconfigured SDK options at construction time. Maps to
 * `type: "configuration_error"`. Includes codes like
 * `invalid_secret_key`, `webhook_missing_secret`. Never retryable —
 * always a developer fix.
 */
export class CrossdeckConfigurationError extends CrossdeckError {
  constructor(payload: CrossdeckErrorPayload) {
    super(payload);
    this.name = "CrossdeckConfigurationError";
    Object.setPrototypeOf(this, CrossdeckConfigurationError.prototype);
  }
}

/**
 * Construct the right `CrossdeckError` subclass for a given payload's
 * `type`. Used by `crossdeckErrorFromResponse` + by any internal call
 * site that throws — gives every thrown error its semantic subclass
 * without forcing every call site to know the mapping.
 */
export function makeCrossdeckError(payload: CrossdeckErrorPayload): CrossdeckError {
  switch (payload.type) {
    case "authentication_error":
      return new CrossdeckAuthenticationError(payload);
    case "permission_error":
      return new CrossdeckPermissionError(payload);
    case "invalid_request_error":
      return new CrossdeckValidationError(payload);
    case "rate_limit_error":
      return new CrossdeckRateLimitError(payload);
    case "network_error":
      return new CrossdeckNetworkError(payload);
    case "internal_error":
      return new CrossdeckInternalError(payload);
    case "configuration_error":
      return new CrossdeckConfigurationError(payload);
    default:
      // Exhaustiveness fallback — also covers the edge case where the
      // backend introduces a new error type before the SDK is updated.
      return new CrossdeckError(payload);
  }
}

export async function crossdeckErrorFromResponse(res: Response): Promise<CrossdeckError> {
  const requestId = res.headers.get("x-request-id") ?? undefined;
  const retryAfterMs = parseRetryAfterHeader(res.headers.get("retry-after"));
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const envelope = (body as { error?: Partial<CrossdeckErrorPayload> & { request_id?: string } })?.error;
  if (envelope && typeof envelope.type === "string" && typeof envelope.code === "string") {
    return makeCrossdeckError({
      type: envelope.type as CrossdeckErrorType,
      code: envelope.code,
      message: envelope.message ?? `HTTP ${res.status}`,
      requestId: envelope.request_id ?? requestId,
      status: res.status,
      retryAfterMs,
    });
  }
  return makeCrossdeckError({
    type: typeMapForStatus(res.status),
    code: `http_${res.status}`,
    message: `HTTP ${res.status} ${res.statusText || ""}`.trim(),
    requestId,
    status: res.status,
    retryAfterMs,
  });
}

export function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const secs = Number(trimmed);
    if (!Number.isFinite(secs) || secs < 0) return undefined;
    return Math.round(secs * 1000);
  }
  if (!/[a-zA-Z,/:]/.test(trimmed)) return undefined;
  const target = Date.parse(trimmed);
  if (!Number.isFinite(target)) return undefined;
  const delta = target - Date.now();
  return delta > 0 ? delta : 0;
}

function typeMapForStatus(status: number): CrossdeckErrorType {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "internal_error";
}
