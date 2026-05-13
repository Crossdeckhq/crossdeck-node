/**
 * Gate 3 — `_sdk-snippets.js` compile check.
 *
 * This file is NOT a test (no `.test.ts` suffix). It's a static
 * type-check fixture covering the FULL Node public surface that
 * `_sdk-snippets.js` references — both the `nodeInstallSnippet`
 * output AND the broader USP 2 + USP 3 surface the AI install
 * prompt directs developers toward. `npm run lint` (`tsc --noEmit`)
 * must succeed against it; if the snippet references an SDK method
 * or option that doesn't exist, lint fails — exactly the gate that
 * v0.1.0 was missing.
 *
 * When you edit `_sdk-snippets.js`, mirror the change here so the
 * gate keeps pace. A future v0.3 CI script will generate this file
 * dynamically; until then it's a manual mirror.
 *
 * Sections:
 *   1. nodeInstallSnippet mirror — boot + uncaughtException + flush
 *   2. USP 2 mirror — register / group / track / ingest
 *   3. USP 3 mirror — getEntitlements / isEntitled / verifyWebhookSignature
 *   4. auto-events subpath — crossdeckExpress / wrapLambdaHandler / wrapFunction
 */

// IMPORTANT: the real snippet imports from "@cross-deck/node". This
// file imports from "../src" so tsc resolves against the source tree
// without needing an npm-installed version of the package. The TYPE
// surface checked is identical.
import {
  CrossdeckServer,
  CrossdeckError,
  verifyWebhookSignature,
  signWebhookPayload,
  scrubPiiFromProperties,
} from "../src/index";
import {
  crossdeckExpress,
  crossdeckExpressErrorHandler,
  wrapLambdaHandler,
  wrapFunction,
} from "../src/auto-events/index";

// ----- Mirror of `nodeInstallSnippet` output, framework-agnostic -----

// 1. Boot. Environment is inferred from the secret-key prefix
//    (cd_sk_test_… → sandbox, cd_sk_live_… → production). The snippet
//    intentionally does NOT pass an `environment` field — that's
//    web-SDK terminology where the publishable key and the env
//    declaration are separate.
const crossdeck = new CrossdeckServer({
  secretKey: process.env.CROSSDECK_SECRET_KEY ?? "",
  appId: "app_node_xxxxxxxxxxxx",
});

// 2. Wire process-level error handlers (Node-style runtimes only).
//    Cloudflare Workers / Vercel Edge don't expose process.on — those
//    runtimes are out of scope for v1.0.0 (the snippet's comment
//    block warns the developer; the code path is guarded).
if (typeof process !== "undefined" && typeof process.on === "function") {
  process.on("unhandledRejection", (err) => {
    crossdeck.captureError(err);
  });

  // uncaughtException: the snippet captures, awaits the flush, then
  // exits. `captureError` is synchronous-void (enqueue), `flush()` is
  // the async drain. The 2-second cap stops a broken transport from
  // blocking shutdown forever.
  process.on("uncaughtException", (err) => {
    crossdeck.captureError(err);
    Promise.race([
      crossdeck.flush(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 2000);
      }),
    ])
      .catch(() => undefined)
      .finally(() => process.exit(1));
  });
}

// 3. Capture errors with request context inside route handlers. The
//    snippet shows this in a comment; the type check still has to
//    cover the API surface so we exercise it here.
async function exampleRouteHandler(req: { url: string; method: string }): Promise<void> {
  try {
    // ... real work ...
  } catch (err) {
    crossdeck.captureError(err, {
      context: { url: req.url, method: req.method },
      tags: { flow: "checkout" },
      level: "error",
    });
    throw err;
  }
}

// 4. Before script / serverless invocation exits, drain the queue.
async function exampleShutdown(): Promise<void> {
  await crossdeck.flush();
}

// ============================================================
// USP 2 — Super-properties / groups / analytics tracking
// ============================================================

// register() adds super-properties carried on every subsequent event.
// Mixpanel idiom — `null` deletes a key.
crossdeck.register({ tenant: "acme", plan: "pro", releaseChannel: "beta" });
crossdeck.register({ releaseChannel: null });
crossdeck.unregister("tenant");
const supers: Record<string, unknown> = crossdeck.getSuperProperties();

// group() attaches `$groups.<type>: id` to every event. Mixpanel /
// Segment Group Analytics pattern.
crossdeck.group("org", "acme_inc");
crossdeck.group("team", "design", { headcount: 12 });
crossdeck.group("org", null); // clear
const groups = crossdeck.getGroups();

// track() — synchronous enqueue, returns void.
crossdeck.track({
  name: "paywall_shown",
  developerUserId: "user_42",
  properties: { variant: "v3" },
});

// ingest() — immediate POST for bulk imports.
async function exampleBulkImport(): Promise<void> {
  await crossdeck.ingest(
    [
      { name: "job.completed", crossdeckCustomerId: "cdcust_x", properties: { durationMs: 1200 } },
      { name: "job.completed", crossdeckCustomerId: "cdcust_y", properties: { durationMs: 950 } },
    ],
    { idempotencyKey: "batch_import_2025_01" },
  );
}

// ============================================================
// USP 3 — Entitlement cache + webhook verification
// ============================================================

async function exampleEntitlementGate(userId: string): Promise<boolean> {
  // First call warms the cache + records the userId alias.
  await crossdeck.getEntitlements({ userId });
  // Subsequent calls are synchronous memory reads (within TTL).
  return crossdeck.isEntitled({ userId }, "pro");
}

async function exampleListEntitlements(userId: string): Promise<void> {
  await crossdeck.getEntitlements({ userId });
  const ents = crossdeck.listEntitlements({ userId });
  ents.forEach((e) => {
    if (e.isActive) {
      // ... grant access ...
    }
  });
}

const unsubscribe = crossdeck.onEntitlementsChange((customerId, ents) => {
  // React to cache changes — e.g. push to connected clients
  void customerId;
  void ents;
});
unsubscribe(); // idempotent

// Webhook signature verification — Stripe pattern.
function exampleWebhookHandler(
  payload: string,
  signatureHeader: string | undefined,
): unknown {
  try {
    return verifyWebhookSignature(payload, signatureHeader, process.env.CROSSDECK_WEBHOOK_SECRET, {
      replayToleranceMs: 5 * 60_000,
    });
  } catch (err) {
    if (err instanceof CrossdeckError && err.code === "webhook_replay_window_exceeded") {
      // Treat replay/skew separately if your monitoring needs to
      // differentiate.
    }
    throw err;
  }
}

// Pure-function signing for fixture authors who need to mint
// Crossdeck-shaped headers in their own tests.
const ts = Math.floor(Date.now() / 1000);
const fixtureSig = signWebhookPayload('{"x":1}', "whsec_x", ts);
void fixtureSig;

// PII scrub utility — opt-in for callers who want defensive PII
// redaction on forwarded properties.
const scrubbed = scrubPiiFromProperties({
  url: "/users/wes@pinet.co.za/",
  card: "4242 4242 4242 4242",
});
void scrubbed;

// ============================================================
// auto-events subpath — framework adapters
// ============================================================

// Express middleware (4-arg signature for register, 4-arg for error
// handler). Customer registers both.
type AnyExpressApp = {
  use(fn: ((req: unknown, res: unknown, next: unknown) => void) | ((err: unknown, req: unknown, res: unknown, next: unknown) => void)): void;
};
function exampleExpressApp(app: AnyExpressApp): void {
  app.use(crossdeckExpress(crossdeck) as unknown as (req: unknown, res: unknown, next: unknown) => void);
  // ... routes ...
  app.use(crossdeckExpressErrorHandler(crossdeck) as unknown as (err: unknown, req: unknown, res: unknown, next: unknown) => void);
}

// AWS Lambda handler wrap. Generic preserves the handler signature.
const exampleLambdaHandler = wrapLambdaHandler(
  crossdeck,
  async (event: { name: string }, _ctx) => ({ statusCode: 200, body: event.name }),
);

// Firebase / Cloud Run generic wrap. Shape-preserving.
const exampleFirebaseHandler = wrapFunction(
  crossdeck,
  async (req: { method: string; path: string }): Promise<string> => `${req.method} ${req.path}`,
  {
    getMetadata: (args) => {
      const req = args[0] as { method: string; path: string };
      return {
        identity: { developerUserId: undefined },
        properties: { method: req.method, path: req.path },
      };
    },
  },
);

// Reference the helpers so tsc doesn't strip them as unused exports.
export const __gate3 = {
  // USP 1
  exampleRouteHandler,
  exampleShutdown,
  crossdeck,
  // USP 2
  supers,
  groups,
  exampleBulkImport,
  // USP 3
  exampleEntitlementGate,
  exampleListEntitlements,
  exampleWebhookHandler,
  // auto-events
  exampleExpressApp,
  exampleLambdaHandler,
  exampleFirebaseHandler,
};
