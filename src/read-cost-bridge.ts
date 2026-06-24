/**
 * Read-cost bridge — the one-way seam from the Crossdeck SDK to the Buckets OSS
 * collector (`@cross-deck/buckets`), without either package depending on the other.
 *
 * Buckets, at `init()`, registers a setter on a well-known global key. This module
 * looks that setter up and calls it. If Buckets isn't installed, the global is
 * absent and every call here is a silent no-op — the SDK never requires Buckets,
 * and Buckets never requires the SDK.
 *
 * What it carries is the cross-match input: WHO (the identified user behind a
 * request) and WHAT (the route / operation). Buckets stamps those onto every
 * database read that happens inside the request's async context, so a heavy read
 * attributes to "this user's this operation" instead of an anonymous collection.
 *
 * The global key and context shape MUST match `@cross-deck/buckets`'
 * `actor-bridge.ts` (`BUCKETS_BRIDGE_KEY`, `RequestContext`). They are a wire
 * contract between two independently-published packages — keep them in lockstep.
 */

/** Must equal `BUCKETS_BRIDGE_KEY` in @cross-deck/buckets. */
const BUCKETS_BRIDGE_KEY = "__crossdeckBucketsBridge__";

/** The cross-match context. Only the provided fields are applied. */
export interface ReadCostContext {
  /** WHO — the identified user behind this request (the developer's own id). */
  actor?: string;
  /** WHAT — the operation/feature that spent the reads. */
  feature?: string;
  /** WHAT (fallback) — the matched route pattern, e.g. `/users/:id`. */
  route?: string;
}

type BridgeSetter = (ctx: ReadCostContext) => void;

/**
 * Push the cross-match context into Buckets for the current request's async
 * context. No-op (and never throws) when the Buckets collector isn't installed.
 */
export function bridgeReadCost(ctx: ReadCostContext): void {
  try {
    const setter = (globalThis as Record<string, unknown>)[BUCKETS_BRIDGE_KEY] as
      | BridgeSetter
      | undefined;
    if (typeof setter === "function") setter(ctx);
  } catch {
    /* metering is best-effort — never disturb the host application */
  }
}
