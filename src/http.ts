import { CrossdeckError, crossdeckErrorFromResponse } from "./errors";
import { validateEventProperties } from "./event-validation";

export const SDK_NAME = "@cross-deck/node";
export const SDK_VERSION = "0.1.0";
export const DEFAULT_BASE_URL = "https://api.cross-deck.com/v1";
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface HttpClientConfig {
  secretKey: string;
  baseUrl: string;
  sdkVersion: string;
  timeoutMs?: number;
}

export interface HttpRequestOptions {
  body?: unknown;
  query?: Record<string, string | undefined>;
  timeoutMs?: number;
  idempotencyKey?: string;
}

export class HttpClient {
  constructor(private readonly config: HttpClientConfig) {}

  async request<T>(
    method: "GET" | "POST",
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.secretKey}`,
      "Crossdeck-Sdk-Version": `${SDK_NAME}@${this.config.sdkVersion}`,
      Accept: "application/json",
    };
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    let bodyInit: RequestInit["body"] | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyInit = serializeRequestBody(options.body);
    }

    const effectiveTimeout = options.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller =
      typeof AbortController !== "undefined" && effectiveTimeout > 0
        ? new AbortController()
        : null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (controller && effectiveTimeout > 0) {
      timeoutHandle = setTimeout(() => controller.abort(), effectiveTimeout);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: bodyInit,
        signal: controller?.signal,
      });
    } catch (err) {
      const aborted = controller?.signal?.aborted === true;
      throw new CrossdeckError({
        type: "network_error",
        code: aborted ? "request_timeout" : "fetch_failed",
        message: aborted
          ? `Request to ${path} aborted after ${effectiveTimeout}ms`
          : err instanceof Error
            ? err.message
            : "fetch failed",
      });
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
      throw await crossdeckErrorFromResponse(response);
    }

    if (response.status === 204) return undefined as T;

    try {
      return (await response.json()) as T;
    } catch {
      throw new CrossdeckError({
        type: "internal_error",
        code: "invalid_json_response",
        message: "Server returned a 2xx with an unparseable body.",
        requestId: response.headers.get("x-request-id") ?? undefined,
        status: response.status,
      });
    }
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
