/**
 * Express auto-events — `request.handled` middleware + uncaught-route
 * error capture.
 *
 * Two middleware factories, registered separately because Express
 * differentiates them by arity:
 *
 *   import { crossdeckExpress, crossdeckExpressErrorHandler } from
 *     "@cross-deck/node/auto-events";
 *
 *   app.use(crossdeckExpress(server));        // request middleware
 *   app.use(routes);                          // your routes
 *   app.use(crossdeckExpressErrorHandler(server)); // LAST — error middleware
 *
 * `crossdeckExpress` emits `request.handled` on response 'finish'
 * with the matched route pattern (not the full URL — high-cardinality
 * URL paths kill dashboards), method, statusCode, and durationMs.
 *
 * `crossdeckExpressErrorHandler` catches errors thrown in route
 * handlers (sync OR async — Express 5 supports async handlers
 * natively; Express 4 needs the caller to forward via `next(err)`).
 * The error is shipped with request context (url, method, matched
 * route) attached so the dashboard can group by route.
 *
 * Compatible with both Express 4 and Express 5. The middleware
 * signatures are stable across both versions.
 *
 * No `import` from `express`. The adapter speaks shape-only against
 * Express's request / response objects — customers don't pay a
 * forced dependency on Express just to install the Crossdeck SDK.
 * If `express` is missing at install, this module still compiles.
 */

import type { CrossdeckServer } from "../crossdeck-server";

/**
 * Shape of an Express request object — enough fields for the
 * middleware to do its job without depending on Express's types.
 */
export interface ExpressRequestLike {
  method: string;
  url: string;
  path?: string;
  route?: { path?: string | RegExp | Array<string | RegExp> };
  originalUrl?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/** Shape of an Express response object. */
export interface ExpressResponseLike {
  statusCode: number;
  once(event: "finish" | "close", listener: () => void): unknown;
  /**
   * Optional — Express's response exposes this for reading headers
   * the framework / middleware chain set. Used by the middleware to
   * surface `responseBytes` on the `request.handled` event. If your
   * adapter doesn't have it, the field is simply omitted.
   */
  getHeader?(name: string): string | string[] | number | undefined;
}

export type ExpressNext = (err?: unknown) => void;

export interface CrossdeckExpressOptions {
  /**
   * Routes to skip. Tested against `req.route?.path` if available, else
   * `req.path` / `req.url`. Defaults to a single self-skip for
   * `/crossdeck/*` so the SDK doesn't emit telemetry about its own
   * health endpoints.
   */
  skipPaths?: Array<string | RegExp>;
  /**
   * Optional identity extractor — runs once per request. Whatever it
   * returns is attached to the `request.handled` event so the
   * dashboard can pivot by user. Typical implementation: read
   * `req.user.id` populated by your auth middleware.
   *
   *   crossdeckExpress(server, {
   *     getIdentity: (req) => ({ developerUserId: req.user?.id }),
   *   })
   */
  getIdentity?: (req: ExpressRequestLike) => {
    developerUserId?: string;
    anonymousId?: string;
    crossdeckCustomerId?: string;
  } | null | undefined;
  /**
   * Attach `{ url, method, route }` as `context.request` on captured
   * errors. Default `true`. Set `false` if you have a separate
   * mechanism for capturing request context (Pino bindings, etc).
   */
  captureErrorsWithRequestContext?: boolean;
}

const DEFAULT_SKIP_PATHS: Array<string | RegExp> = [/^\/crossdeck($|\/)/];

/**
 * Express middleware that emits `request.handled` per request.
 * Register BEFORE your routes:
 *
 *   app.use(crossdeckExpress(server));
 *
 * Behaviour:
 *   - Listens on `res.once('finish')` so we capture the FINAL
 *     statusCode after any post-route middleware (compression, etc).
 *     Also listens on `res.once('close')` to cover client-aborted
 *     requests where 'finish' never fires.
 *   - Idempotent per request: dispatches once regardless of which
 *     terminal event fires first.
 *   - `route` property is the matched route PATTERN (`/users/:id`),
 *     not the full URL — keeps dashboard cardinality manageable. Falls
 *     back to `req.path` when no route matched (404s).
 *   - Errors thrown by `getIdentity` are swallowed and the event still
 *     ships without identity — telemetry must NEVER break the request
 *     pipeline.
 */
export function crossdeckExpress(
  server: CrossdeckServer,
  options: CrossdeckExpressOptions = {},
) {
  const skipPaths = options.skipPaths ?? DEFAULT_SKIP_PATHS;

  return function crossdeckExpressMiddleware(
    req: ExpressRequestLike,
    res: ExpressResponseLike,
    next: ExpressNext,
  ): void {
    if (shouldSkipRequest(req, skipPaths)) {
      next();
      return;
    }

    const start = Date.now();
    let dispatched = false;

    const emit = (): void => {
      if (dispatched) return;
      dispatched = true;
      let identity: ReturnType<NonNullable<CrossdeckExpressOptions["getIdentity"]>> = undefined;
      try {
        identity = options.getIdentity?.(req);
      } catch {
        // identity extraction must never break the request pipeline
      }
      try {
        const props: Record<string, unknown> = {
          route: extractRoutePattern(req),
          method: req.method,
          statusCode: res.statusCode,
          durationMs: Date.now() - start,
        };
        // Defensive: every header read is in a try/swallow because a
        // misbehaving framework middleware may have mutated the
        // response in ways that throw on access.
        try {
          const ua = readHeader(req, "user-agent");
          if (ua) props.userAgent = ua;
        } catch {
          // skip
        }
        try {
          const cl = typeof res.getHeader === "function" ? res.getHeader("content-length") : undefined;
          if (typeof cl === "number") {
            props.responseBytes = cl;
          } else if (typeof cl === "string") {
            const parsed = Number(cl);
            if (Number.isFinite(parsed)) props.responseBytes = parsed;
          }
        } catch {
          // skip
        }
        server.track({
          name: "request.handled",
          developerUserId: identity?.developerUserId,
          anonymousId: identity?.anonymousId,
          crossdeckCustomerId: identity?.crossdeckCustomerId,
          properties: props,
        });
      } catch {
        // SDK telemetry must never throw out of the response pipeline.
      }
    };

    res.once("finish", emit);
    res.once("close", emit);

    next();
  };
}

/**
 * Express error middleware (4-arg signature). Register LAST, after
 * all routes + after the request middleware:
 *
 *   app.use(crossdeckExpressErrorHandler(server));
 *
 * Captures the error with request context, then forwards to the next
 * error handler — Crossdeck observes, the framework still produces the
 * normal 500 response.
 *
 * In Express 5 (async handlers natively forward errors), this middleware
 * sees errors from any handler. In Express 4, customers must wrap async
 * route handlers in a `next(err)` adapter — that's not a Crossdeck
 * limitation; it's how Express 4 works.
 */
export function crossdeckExpressErrorHandler(
  server: CrossdeckServer,
  options: CrossdeckExpressOptions = {},
) {
  const attachContext = options.captureErrorsWithRequestContext !== false;

  return function crossdeckExpressErrorMiddleware(
    err: unknown,
    req: ExpressRequestLike,
    _res: ExpressResponseLike,
    next: ExpressNext,
  ): void {
    try {
      if (attachContext) {
        server.captureError(err, {
          context: {
            request: {
              url: req.originalUrl ?? req.url,
              method: req.method,
              route: extractRoutePattern(req),
            },
          },
        });
      } else {
        server.captureError(err);
      }
    } catch {
      // SDK observation must not block the framework's error pipeline.
    }
    next(err);
  };
}

// ---------- helpers (exported for testing) ----------

export function shouldSkipRequest(
  req: ExpressRequestLike,
  skipPaths: Array<string | RegExp>,
): boolean {
  const candidates = [req.path, req.url].filter((s): s is string => typeof s === "string");
  for (const candidate of candidates) {
    for (const pattern of skipPaths) {
      if (typeof pattern === "string" && candidate.startsWith(pattern)) return true;
      if (pattern instanceof RegExp && pattern.test(candidate)) return true;
    }
  }
  return false;
}

function readHeader(req: ExpressRequestLike, name: string): string | undefined {
  if (!req.headers) return undefined;
  const v = req.headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

export function extractRoutePattern(req: ExpressRequestLike): string {
  const routePath = req.route?.path;
  if (typeof routePath === "string") return routePath;
  if (routePath instanceof RegExp) return routePath.source;
  if (Array.isArray(routePath)) {
    return routePath
      .map((p) => (typeof p === "string" ? p : p instanceof RegExp ? p.source : ""))
      .filter(Boolean)
      .join("|");
  }
  // Fallback for 404s + middleware-only requests where `req.route` is
  // undefined. Use `req.path` (the URL path without query string)
  // when present, else `req.url` as a last resort.
  return req.path ?? req.url ?? "<unknown>";
}
