/**
 * Firebase Cloud Functions wrapper — generic across v1 + v2, also
 * usable for Google Cloud Run Functions and Cloud Run services
 * (anything that exposes a Node handler and freezes / tears down
 * between invocations).
 *
 * Why generic: Firebase has many handler signatures across v1 and v2:
 *   v1 https.onRequest:  (req, res) => void
 *   v1 https.onCall:     (data, context) => Promise<result>
 *   v1 firestore.onWrite: (snapshot, context) => Promise<void>
 *   v1 pubsub.onPublish: (message, context) => Promise<void>
 *   v2 onRequest:        (req, res) => Promise<void>
 *   v2 onCall:           (request) => Promise<result>
 *   v2 onDocumentWritten: (event) => Promise<void>
 *
 * Rather than ship one wrapper per signature (which would force a
 * dependency on `firebase-functions` types and break when Google
 * adds new triggers), this wrapper is **shape-preserving** — it
 * accepts ANY function and returns one with the same signature.
 * Lifecycle telemetry is emitted around the call; metadata extraction
 * is plug-in via `getMetadata`.
 *
 *   import { wrapFunction } from "@cross-deck/node/auto-events";
 *   import { onRequest } from "firebase-functions/v2/https";
 *
 *   export const myFunction = onRequest(wrapFunction(server, async (req, res) => {
 *     // your handler
 *   }));
 *
 * Cold-start detection: same per-container logic as Lambda. The
 * first invocation of a fresh container is a cold start; subsequent
 * invocations of the same warm container are not.
 *
 * Flush-before-return: same critical contract as Lambda. Firebase
 * tears down idle containers; queued events vanish if the SDK doesn't
 * flush before the handler returns.
 */

import type { CrossdeckServer } from "../crossdeck-server";

export interface WrapFunctionOptions {
  /**
   * Override the per-container cold-start flag. Module-level
   * detection is sufficient for production; tests use this to
   * deterministically reset cold-start across runs.
   */
  resetColdStart?: boolean;
  /**
   * Optional metadata extractor — read trigger-specific fields off
   * the handler arguments and attach them to the emitted events.
   * Default: no extra metadata.
   *
   * Return `{ identity, properties }` so identity hints route onto
   * the event envelope (for dashboard pivot) and properties merge
   * into the event's `properties` bag:
   *
   *   wrapFunction(server, handler, {
   *     getMetadata: (args) => ({
   *       identity: { developerUserId: args[0].auth?.uid },
   *       properties: { docPath: args[0].ref?.path, region: "us-central1" },
   *     }),
   *   })
   */
  getMetadata?: (args: unknown[]) => WrapFunctionMetadata | null | undefined;
  /**
   * Label for the `runtime` event property. Defaults to
   * `"firebase-functions"`. Override to distinguish triggers in
   * dashboards (e.g. `"firebase-https"` vs `"firebase-firestore"`).
   */
  runtime?: string;
}

export interface WrapFunctionMetadata {
  /** Identity hint attached to the event envelope (developerUserId / anonymousId / crossdeckCustomerId). */
  identity?: {
    developerUserId?: string;
    anonymousId?: string;
    crossdeckCustomerId?: string;
  };
  /** Additional properties merged into emitted event properties. */
  properties?: Record<string, unknown>;
}

let containerColdStart = true;

/**
 * Shape-preserving wrap for a Firebase / Cloud Run handler. Returns
 * a function with the SAME signature as the input.
 *
 * Lifecycle emitted:
 *   - `function.invoked` on entry — runtime, coldStart, ...metadata
 *   - `function.completed` on success — durationMs, memoryUsedMb
 *   - `function.failed` on throw — errorType, errorMessage, durationMs
 *
 * Failures also call `server.captureError(err)`. Errors are re-thrown
 * so Firebase still sees the failure and reports it to Cloud Logging.
 *
 * `await server.flush()` runs in `finally` — same as Lambda. Firebase
 * containers freeze / tear down between invocations.
 */
export function wrapFunction<TArgs extends unknown[], TResult>(
  server: CrossdeckServer,
  handler: (...args: TArgs) => Promise<TResult> | TResult,
  options: WrapFunctionOptions = {},
): (...args: TArgs) => Promise<TResult> {
  if (options.resetColdStart === true) containerColdStart = true;
  const runtime = options.runtime ?? "firebase-functions";

  return async function wrappedFirebaseHandler(...args: TArgs): Promise<TResult> {
    const start = Date.now();
    const coldStart = containerColdStart;
    containerColdStart = false;
    const metadata = safeExtractMetadata(options.getMetadata, args);
    const identity = metadata?.identity ?? {};
    const extraProps = metadata?.properties ?? {};

    server.track({
      name: "function.invoked",
      developerUserId: identity.developerUserId,
      anonymousId: identity.anonymousId,
      crossdeckCustomerId: identity.crossdeckCustomerId,
      properties: {
        runtime,
        coldStart,
        ...extraProps,
      },
    });

    try {
      const result = await handler(...args);
      server.track({
        name: "function.completed",
        developerUserId: identity.developerUserId,
        anonymousId: identity.anonymousId,
        crossdeckCustomerId: identity.crossdeckCustomerId,
        properties: {
          runtime,
          durationMs: Date.now() - start,
          memoryUsedMb: rssMb(),
          ...extraProps,
        },
      });
      return result;
    } catch (err) {
      try {
        server.captureError(err, {
          context: { firebase: extraProps },
        });
      } catch {
        // self-protection — error capture must never block re-throw
      }
      try {
        server.track({
          name: "function.failed",
          developerUserId: identity.developerUserId,
          anonymousId: identity.anonymousId,
          crossdeckCustomerId: identity.crossdeckCustomerId,
          properties: {
            runtime,
            errorType: err instanceof Error ? err.name : null,
            errorMessage: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - start,
            ...extraProps,
          },
        });
      } catch {
        // swallow — same self-protection
      }
      throw err;
    } finally {
      try {
        await server.flush();
      } catch {
        // Flush failure is observable via diagnostics.events.lastError.
      }
    }
  };
}

function safeExtractMetadata(
  extractor: WrapFunctionOptions["getMetadata"] | undefined,
  args: unknown[],
): WrapFunctionMetadata | undefined {
  if (!extractor) return undefined;
  try {
    const out = extractor(args);
    return out ?? undefined;
  } catch {
    return undefined;
  }
}

function rssMb(): number {
  try {
    return Math.round(process.memoryUsage().rss / 1024 / 1024);
  } catch {
    return 0;
  }
}
