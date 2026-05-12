# Changelog

All notable changes to `@cross-deck/node` will be documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-12

Initial server SDK release.

### Added

- Separate `@cross-deck/node` package with no browser assumptions.
- `CrossdeckServer` constructor with secret-key validation.
- Secret-key HTTP transport with typed `CrossdeckError` handling.
- Web-parity sanitisation for traits and event properties, plus a transport
  backstop that converts serialization failures into stable `CrossdeckError`s.
- `identify()` / `aliasIdentity()` for server-side identity linking.
- `forget()` for server-side GDPR/CCPA deletion requests.
- `getEntitlements()` by `customerId`, `userId`, or `anonymousId`.
- `getCustomerEntitlements(customerId)` server-only direct lookup route.
- `track()` and `ingest()` for explicit server-side event ingest.
- `syncPurchases()` for Apple signed purchase forwarding.
- `grantEntitlement()` and `revokeEntitlement()` server-side manual overrides.
- `getAuditEntry()` for server-side audit-log reads.
- Dual ESM/CJS build.
- Strict TypeScript + Vitest coverage for transport and public method routing.
