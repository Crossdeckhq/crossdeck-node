/**
 * @cross-deck/node — end-to-end smoke spec (Gate 6)
 *
 * Loads the real BUILT bundle (`dist/index.cjs`) in a child Node
 * process, mocks the Crossdeck API with a local http.createServer,
 * and asserts the SDK's real wire shape — exactly the test that
 * would have caught the v0.1.0 `captureError` regression in seconds.
 *
 * Node-to-Node — no Playwright. The parent vitest process owns the
 * mock backend; the child process is the consumer. Each test spawns
 * a fresh child so process-level state (super-props, runtime info,
 * uncaughtException handlers) is clean.
 *
 * What this catches that unit tests don't:
 *   - The built bundle exports every public symbol the snippet uses
 *     (compile-time + import-time regression gate).
 *   - Real fetch() calls fire with the right method, URL, body, and
 *     headers (Authorization: Bearer cd_sk_…, Idempotency-Key, SDK
 *     version header).
 *   - flush-on-exit actually drains the queue before the child exits.
 *   - process.on('uncaughtException') lands an error.unhandled event
 *     on the wire with parsed frames + runtime info.
 *   - Entitlement TTL cache: second isEntitled call does not hit the
 *     network within the TTL window.
 *   - Webhook signature helper verifies a Stripe-shaped header.
 *
 * Stub — assertions land alongside the src files they cover.
 */

import { describe, it } from "vitest";

describe("@cross-deck/node — end-to-end smoke", () => {
  it.todo("the built dist/index.cjs imports without throwing");
  it.todo("the built bundle exports CrossdeckServer, CrossdeckError, captureError, captureMessage, register, group, flush, isEntitled, listEntitlements, diagnostics");
  it.todo("the built bundle exports crossdeckExpress / wrapLambdaHandler / wrapFunction from './auto-events'");
  it.todo("the built bundle exports verifyWebhookSignature");

  it.todo("init() + track() POSTs /events with Authorization: Bearer cd_sk_test_… and Idempotency-Key: batch_…");
  it.todo("Crossdeck-Sdk-Version header includes '@cross-deck/node@' + the package version");
  it.todo("Content-Type: application/json on every POST body");
  it.todo("ingest([event1, event2]) batches into ONE POST request");

  it.todo("a Retry-After header on a mocked 429 schedules the retry at the server-supplied delay");
  it.todo("retried batch reuses the SAME Idempotency-Key value");

  it.todo("throwing inside the child process triggers a POST containing an error.unhandled event with parsed stack frames");
  it.todo("captureError(new Error('e2e_test')) ships an error.handled event with the runtime-info bag attached (nodeVersion, os.platform, hostname)");

  it.todo("flush-on-exit: track 3 events then exit cleanly — the parent receives all 3 before process.exit");
  it.todo("flush-on-exit: SIGTERM on the child drains the queue within exitFlushTimeoutMs");

  it.todo("entitlement TTL cache: first isEntitled('pro') triggers a GET /entitlements; second call within TTL does NOT");
  it.todo("entitlement TTL cache: after TTL elapses, isEntitled triggers a refetch");

  it.todo("verifyWebhookSignature: a Stripe-shaped 't=<unix>,v1=<hex>' header over a known payload verifies");
  it.todo("verifyWebhookSignature: a tampered payload throws CrossdeckError({ code: 'webhook_invalid_signature' })");

  it.todo("the snippet at backend/_sdk-snippets.js node-bootstrap output compiles + runs against the built bundle (the v0.1.0 regression gate)");
});
