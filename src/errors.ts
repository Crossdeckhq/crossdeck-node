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
    return new CrossdeckError({
      type: envelope.type as CrossdeckErrorType,
      code: envelope.code,
      message: envelope.message ?? `HTTP ${res.status}`,
      requestId: envelope.request_id ?? requestId,
      status: res.status,
      retryAfterMs,
    });
  }
  return new CrossdeckError({
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
