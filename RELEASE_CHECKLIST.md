# `@cross-deck/node` release checklist

Procedural gate before every `npm publish`. The goal is the same as the web
SDK: no surprises, no silent contract drift, no half-tested artefacts.

---

## 0. Pre-flight

- [ ] `package.json`, `src/http.ts:SDK_VERSION`, and `CHANGELOG.md` agree.
- [ ] Backend routes used by the SDK are merged and deployed together with
      the SDK version that depends on them.
- [ ] README examples match the current public methods exactly.
- [ ] Public source repo exists at `VistaApps-za/crossdeck-node`.
- [ ] `package.json → repository.url` points at the public `crossdeck-node`
      repo before publishing to npm.
- [ ] `./sync-to-public-repo.sh "<release commit message>"` has mirrored the
      SDK into the public repo.

## 1. Automated gates

Run from `sdks/node/`:

```bash
npm run lint
npm test
npm run build
```

Or in one shot:

```bash
npm run prepublishOnly
```

All three must exit zero.

## 2. Contract smoke

Use a real secret key against a sandbox project and verify:

1. `identify()` returns `alias_result`.
2. `getEntitlements({ userId })` returns a `list` envelope.
3. `track()` lands on `/v1/events` and returns `received: 1`.
4. `grantEntitlement()` returns `entitlement_mutation` with `action: "grant"`.
5. `revokeEntitlement()` returns `entitlement_mutation` with `action: "revoke"`.
6. `getAuditEntry()` returns the audit row created by the grant/revoke step.

## 3. Dry-run publish

```bash
cd sdks/node
npm publish --dry-run
```

Verify the tarball includes:

- `dist/index.{cjs,mjs}`
- `dist/index.d.{ts,mts}`
- `README.md`
- `CHANGELOG.md`
- `LICENSE`
- `package.json`

Verify it does not include:

- `tests/`
- `node_modules/`
- `tsconfig.json`
- `tsup.config.ts`
- `vitest.config.ts`
- `RELEASE_CHECKLIST.md`

## 4. Publish

```bash
cd sdks/node
npm whoami
npm publish --access public
```

## 5. Post-publish verification

```bash
npm view @cross-deck/node@<version> dist
```

Confirm the tarball resolves and the published exports match the local
dry-run output.
