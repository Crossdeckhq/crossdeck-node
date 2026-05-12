# @cross-deck/node

The Crossdeck server SDK for Node.js.

This is the **secret-key** SDK: server-only, no browser assumptions, no
auto-tracking, no local state. It wraps the real HTTP surface for
entitlements, identity aliasing, event ingest, purchase forwarding, manual
entitlement overrides, and audit reads.

```bash
npm install @cross-deck/node
```

## Quick start

```ts
import { CrossdeckServer } from "@cross-deck/node";

const crossdeck = new CrossdeckServer({
  secretKey: process.env.CROSSDECK_SECRET_KEY!,
});

const entitlements = await crossdeck.getEntitlements({ userId: "user_847" });

await crossdeck.track({
  name: "invoice.retry_started",
  developerUserId: "user_847",
  properties: { invoiceId: "inv_123" },
});
```

## What this SDK is for

- **Server-side entitlement reads.** Query by `customerId`, `userId`, or `anonymousId`.
- **Identity graph writes.** Alias a known `anonymousId` to your stable `userId`.
- **Telemetry from jobs and backends.** Send events from cron jobs, webhooks, workers, and admin tools.
- **Fast purchase forwarding.** Push signed Apple purchase evidence directly.
- **Manual entitlement controls.** Grant or revoke an entitlement with a reason.
- **Audit lookup.** Read one audit-log entry by event ID.

## What this SDK is not

- Not for browsers.
- Not a wrapper around the web SDK.
- Not a stateful singleton that keeps identity or a queue in memory.
- Not an auto-tracker. Every server call is explicit.

## Constructing the client

```ts
import { CrossdeckServer } from "@cross-deck/node";

const crossdeck = new CrossdeckServer({
  secretKey: process.env.CROSSDECK_SECRET_KEY!,
  baseUrl: "https://api.cross-deck.com/v1", // optional
  timeoutMs: 15_000,                        // optional
  appId: "app_web_xxx",                     // optional informational event envelope field
});
```

`secretKey` must start with `cd_sk_`. The constructor throws immediately on
an invalid key prefix so a server misconfiguration fails at boot, not under
load.

## Identity

### `await crossdeck.identify(userId, anonymousId, options?)`

Alias a pre-login `anonymousId` to your stable user ID. This is the same
identity graph the web SDK uses, just called explicitly from your backend.

```ts
await crossdeck.identify("user_847", "anon_123", {
  email: "wes@example.com",
  traits: { plan: "pro", region: "za" },
});
```

`identify()` is a convenience alias for `aliasIdentity(...)`.

Traits are sanitised before send with the same rules as `@cross-deck/web`:
`BigInt` becomes a string, circular refs become `"[circular]"`, `Map`/`Set`
normalise to JSON-friendly shapes, and functions/symbols/`undefined` are dropped.

### `await crossdeck.forget(hints)`

Queue GDPR/CCPA deletion by `customerId`, `userId`, or `anonymousId`.

```ts
await crossdeck.forget({ customerId: "cdcust_123" });
```

## Entitlements

### `await crossdeck.getEntitlements(hints)`

Read entitlements by any supported identity hint.

```ts
const result = await crossdeck.getEntitlements({ userId: "user_847" });
console.log(result.data.map((e) => e.key));
```

### `await crossdeck.getCustomerEntitlements(customerId)`

Server-only direct lookup by canonical Crossdeck customer ID.

```ts
const result = await crossdeck.getCustomerEntitlements("cdcust_123");
```

### `await crossdeck.grantEntitlement(input)`

Manually grant an entitlement.

```ts
await crossdeck.grantEntitlement({
  customerId: "cdcust_123",
  entitlementKey: "pro",
  duration: "P30D",
  reason: "Support recovery after billing incident",
});
```

### `await crossdeck.revokeEntitlement(input)`

Manually revoke an entitlement.

```ts
await crossdeck.revokeEntitlement({
  customerId: "cdcust_123",
  entitlementKey: "pro",
  reason: "Chargeback",
});
```

## Events

### `await crossdeck.track(event)`

Send one event immediately.

```ts
await crossdeck.track({
  name: "support.refund_issued",
  crossdeckCustomerId: "cdcust_123",
  properties: { ticketId: "ticket_987" },
});
```

Identity is required on every event. Provide at least one of:

- `developerUserId`
- `anonymousId`
- `crossdeckCustomerId`

### `await crossdeck.ingest(events)`

Send a batch in one call.

```ts
await crossdeck.ingest([
  {
    name: "job.started",
    developerUserId: "user_847",
    properties: { job: "daily-mrr-reconcile" },
  },
  {
    name: "job.completed",
    developerUserId: "user_847",
    properties: { job: "daily-mrr-reconcile", durationMs: 842 },
  },
]);
```

The SDK auto-mints `eventId` and `timestamp` if you omit them.

Event `properties` are sanitised with the same contract as the web SDK before
they hit the wire, so one bad backend-shaped object cannot crash request
serialization.

## Purchases

### `await crossdeck.syncPurchases(input)`

Forward Apple signed purchase evidence to Crossdeck.

```ts
await crossdeck.syncPurchases({
  signedTransactionInfo: transactionJws,
  signedRenewalInfo: renewalJws,
});
```

## Audit

### `await crossdeck.getAuditEntry(eventId)`

Read one audit row by event ID.

```ts
const audit = await crossdeck.getAuditEntry("srv_grant_123");
console.log(audit.decision, audit.reason);
```

## Errors

Every non-2xx response is normalised to `CrossdeckError`:

```ts
import { CrossdeckError } from "@cross-deck/node";

try {
  await crossdeck.getEntitlements({ userId: "user_847" });
} catch (err) {
  if (err instanceof CrossdeckError) {
    console.error(err.type, err.code, err.requestId);
  }
}
```

The error fields mirror the backend envelope:

- `type`
- `code`
- `message`
- `requestId`
- `status`
- `retryAfterMs`

## Node version

Node 18+ is required. The SDK uses the platform `fetch` implementation and
does not ship an HTTP dependency.

## License

MIT
