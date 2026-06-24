/**
 * AWS Lambda handler wrapper — emits `function.invoked` /
 * `function.completed` / `function.failed` with Lambda lifecycle
 * metadata, and (crucially) `await server.flush()` BEFORE the handler
 * returns.
 *
 * Why flush-before-return is non-optional on Lambda: the runtime
 * freezes the process between invocations. Any event queued but not
 * sent over the wire vanishes — silently — when the function returns.
 * `flush-on-exit` doesn't fire because the process isn't exiting;
 * it's hibernating. Without the wrapper's explicit flush, you'd lose
 * the very telemetry you installed the SDK for.
 *
 *   import { wrapLambdaHandler } from "@cross-deck/node/auto-events";
 *
 *   export const handler = wrapLambdaHandler(server, async (event, ctx) => {
 *     // your handler
 *   });
 *
 * The wrapper preserves the handler's TypeScript signature via
 * generic parameters so the wrapped handler is type-equivalent to
 * the original.
 *
 * Cold-start detection is per-module-instance: the first invocation
 * gets `coldStart: true`, subsequent invocations of the SAME warm
 * container get `coldStart: false`. AWS spawns multiple containers
 * for concurrent invocations — each container's first invocation is
 * a cold start, so this is a per-container signal, not per-account.
 */

import type { CrossdeckServer } from "../crossdeck-server";
import { bridgeReadCost } from "../read-cost-bridge";

/**
 * Minimal shape of the AWS Lambda invocation context. We don't pull
 * `@types/aws-lambda` as a dependency — that would force every
 * non-Lambda caller to install Lambda types just to import the SDK.
 * The fields we read are the stable subset every Lambda runtime
 * provides.
 */
export interface LambdaContextLike {
  awsRequestId?: string;
  functionName?: string;
  functionVersion?: string;
  invokedFunctionArn?: string;
  memoryLimitInMB?: number | string;
  logGroupName?: string;
  logStreamName?: string;
  /** Time remaining in the invocation, in ms. Useful for context. */
  getRemainingTimeInMillis?: () => number;
}

export type LambdaHandlerLike<TEvent, TResult> = (
  event: TEvent,
  context: LambdaContextLike,
) => Promise<TResult> | TResult;

export interface WrapLambdaOptions {
  /**
   * Override the per-container cold-start flag. Module-level
   * detection is sufficient for production; tests use this to
   * deterministically reset cold-start across runs.
   */
  resetColdStart?: boolean;
  /**
   * Optional identity extractor — read auth context from `event`
   * (e.g. `event.requestContext?.authorizer?.principalId` on an API
   * Gateway invocation) and attach to the emitted events.
   */
  getIdentity?: (event: unknown, context: LambdaContextLike) => {
    developerUserId?: string;
    anonymousId?: string;
    crossdeckCustomerId?: string;
  } | null | undefined;
}

let containerColdStart = true;

/**
 * Wrap a Lambda handler. Returns a handler with the same signature.
 *
 * Lifecycle emitted:
 *   - `function.invoked` on entry  — requestId, functionName, coldStart
 *   - `function.completed` on success — durationMs, memoryUsedMb, statusCode
 *   - `function.failed` on throw — errorType, errorMessage, durationMs
 *
 * Failures also call `server.captureError(err)` so the error pipeline
 * sees it with `error.handled` shape (frames + fingerprint +
 * breadcrumbs). The thrown error is re-thrown after capture so Lambda
 * itself still sees the failure and reports it to CloudWatch.
 *
 * `await server.flush()` runs in the `finally` block of every
 * invocation — bounded best-effort, so a transient backend outage
 * doesn't keep the function alive past the platform's SIGKILL.
 */
export function wrapLambdaHandler<TEvent, TResult>(
  server: CrossdeckServer,
  handler: LambdaHandlerLike<TEvent, TResult>,
  options: WrapLambdaOptions = {},
): LambdaHandlerLike<TEvent, TResult> {
  if (options.resetColdStart === true) containerColdStart = true;

  return async function wrappedLambdaHandler(event, context): Promise<TResult> {
    const start = Date.now();
    const coldStart = containerColdStart;
    containerColdStart = false;
    const identity = safeExtractIdentity(options.getIdentity, event, context);

    // Read-cost cross-match: stamp WHO + WHAT for this invocation before the
    // handler runs, so its database reads attribute to the user and the function.
    // The function name IS the operation on serverless — a natural WHAT. Each
    // invocation is its own async context, so this never leaks across requests.
    // No-op unless @cross-deck/buckets is installed; never throws.
    try {
      bridgeReadCost({ actor: identity?.developerUserId, feature: context.functionName });
    } catch {
      // best-effort — a missing collector is a silent no-op
    }

    server.track({
      name: "function.invoked",
      developerUserId: identity?.developerUserId,
      anonymousId: identity?.anonymousId,
      crossdeckCustomerId: identity?.crossdeckCustomerId,
      properties: {
        runtime: "aws-lambda",
        requestId: context.awsRequestId,
        functionName: context.functionName,
        functionVersion: context.functionVersion,
        coldStart,
        memoryLimitMb: numericOrUndefined(context.memoryLimitInMB),
        remainingMs: safeRemainingMs(context),
      },
    });

    try {
      const result = await handler(event, context);
      const completedProps: Record<string, unknown> = {
        runtime: "aws-lambda",
        requestId: context.awsRequestId,
        functionName: context.functionName,
        durationMs: Date.now() - start,
        memoryUsedMb: rssMb(),
      };
      // API Gateway / Function URL responses are
      // `{ statusCode, body, headers? }`. When the handler returns
      // that shape, surface statusCode + body size on the completed
      // event so the dashboard can pivot by HTTP outcome. Non-HTTP
      // handlers (queue / cron) return arbitrary shapes; we silently
      // skip those keys.
      if (isHttpStyleResponse(result)) {
        completedProps.statusCode = result.statusCode;
        if (typeof result.body === "string") {
          completedProps.responseBytes = Buffer.byteLength(result.body, "utf8");
        }
      }
      server.track({
        name: "function.completed",
        developerUserId: identity?.developerUserId,
        anonymousId: identity?.anonymousId,
        crossdeckCustomerId: identity?.crossdeckCustomerId,
        properties: completedProps,
      });
      return result;
    } catch (err) {
      try {
        server.captureError(err, {
          context: {
            lambda: {
              requestId: context.awsRequestId,
              functionName: context.functionName,
              functionVersion: context.functionVersion,
            },
          },
        });
      } catch {
        // self-protection — error capture must never block re-throw
      }
      try {
        server.track({
          name: "function.failed",
          developerUserId: identity?.developerUserId,
          anonymousId: identity?.anonymousId,
          crossdeckCustomerId: identity?.crossdeckCustomerId,
          properties: {
            runtime: "aws-lambda",
            requestId: context.awsRequestId,
            functionName: context.functionName,
            errorType: err instanceof Error ? err.name : null,
            errorMessage: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - start,
          },
        });
      } catch {
        // swallow — same self-protection
      }
      throw err;
    } finally {
      // CRITICAL — Lambda freezes the process between invocations.
      // Without this, queued events vanish silently the moment the
      // handler returns. `flush()` is best-effort + bounded by the
      // queue's own timeout policy.
      try {
        await server.flush();
      } catch {
        // Flush failure is observable via diagnostics.events.lastError.
      }
    }
  };
}

function safeExtractIdentity(
  extractor: WrapLambdaOptions["getIdentity"] | undefined,
  event: unknown,
  context: LambdaContextLike,
): ReturnType<NonNullable<WrapLambdaOptions["getIdentity"]>> {
  if (!extractor) return undefined;
  try {
    return extractor(event, context);
  } catch {
    return undefined;
  }
}

function safeRemainingMs(context: LambdaContextLike): number | undefined {
  try {
    return typeof context.getRemainingTimeInMillis === "function"
      ? context.getRemainingTimeInMillis()
      : undefined;
  } catch {
    return undefined;
  }
}

function numericOrUndefined(value: number | string | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function rssMb(): number {
  try {
    return Math.round(process.memoryUsage().rss / 1024 / 1024);
  } catch {
    return 0;
  }
}

/**
 * Duck-type detection for API Gateway / Function URL / ALB-style
 * Lambda responses. Real Lambda handlers can return ANY shape — only
 * HTTP-style returns expose statusCode + body. We don't import
 * `@types/aws-lambda` to avoid the dep cost; this duck-type is good
 * enough.
 */
function isHttpStyleResponse(
  value: unknown,
): value is { statusCode: number; body?: string; headers?: Record<string, string> } {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { statusCode?: unknown }).statusCode === "number",
  );
}
