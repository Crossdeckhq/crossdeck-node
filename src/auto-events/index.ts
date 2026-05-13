/**
 * @cross-deck/node/auto-events — framework adapters barrel.
 *
 * Each adapter is a thin wrapper around the core `CrossdeckServer`
 * API. They don't pull their framework's runtime types as a hard
 * dependency — the imports are shape-only — so a customer using
 * Express but not Firebase doesn't pay for `firebase-functions`
 * types, and vice versa.
 *
 * The three adapters approved for v1.0.0 (per the SDK_TRUTH.md
 * capability matrix Q1 decision):
 *   - Express + ExpressErrorHandler — `request.handled` + route-error capture
 *   - Lambda — `function.invoked` / `completed` / `failed` + flush-before-return
 *   - Firebase / Cloud Run — generic `wrapFunction` for any handler shape
 *
 * Fastify is deferred to v0.3.0 (Q1 decision). Cloudflare Workers and
 * Vercel Edge are deferred to v0.4+ (no `process.on(...)` lifecycle
 * in Workers — flush-on-exit needs a runtime-specific pattern).
 */

export {
  crossdeckExpress,
  crossdeckExpressErrorHandler,
  shouldSkipRequest,
  extractRoutePattern,
} from "./express";
export type {
  CrossdeckExpressOptions,
  ExpressNext,
  ExpressRequestLike,
  ExpressResponseLike,
} from "./express";

export { wrapLambdaHandler } from "./lambda";
export type {
  LambdaContextLike,
  LambdaHandlerLike,
  WrapLambdaOptions,
} from "./lambda";

export { wrapFunction } from "./firebase";
export type { WrapFunctionOptions, WrapFunctionMetadata } from "./firebase";
