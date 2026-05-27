#!/usr/bin/env node
/**
 * Emit `dist/contracts.json` — the per-SDK bank-grade contracts
 * sidecar. Run by `npm run build` AFTER tsup produces the JS
 * bundles.
 *
 * Why a sidecar: customer CI, dashboards, and AI integration
 * assistants need a machine-readable index of the behavioural
 * guarantees this SDK ships. Bundling contracts INTO the npm
 * package means the customer's lockfile pins SDK code + contracts
 * atomically — drift between the SDK they're using and the
 * contracts they're asserting against becomes physically impossible.
 *
 * Source of truth: `contracts/**\/*.json` at the monorepo root.
 * This script filters by `appliesTo` containing "node" and writes
 * the matching subset, stamped with `bundledIn`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sdkRoot = path.resolve(__dirname, "..");
const distDir = path.join(sdkRoot, "dist");
const repoRoot = path.resolve(sdkRoot, "../..");
const contractsRoot = path.join(repoRoot, "contracts");
const target = path.join(distDir, "contracts.json");

const SDK_IDENTIFIER = "node";

function readSdkVersion() {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8"),
  );
  return pkg.version;
}

const sdkVersion = readSdkVersion();
const bundledIn = `@cross-deck/${SDK_IDENTIFIER}@${sdkVersion}`;

if (!fs.existsSync(distDir)) {
  console.error(
    `[emit-contracts] dist/ not found — run "npm run build" first; this script runs after tsup.`,
  );
  process.exit(1);
}

if (!fs.existsSync(contractsRoot)) {
  console.error(
    `[emit-contracts] contracts/ directory missing at ${contractsRoot}.`,
  );
  process.exit(1);
}

function collectContracts(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectContracts(full));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      found.push(full);
    }
  }
  return found;
}

const files = collectContracts(contractsRoot);
const matchingContracts = [];
for (const file of files) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`[emit-contracts] failed to parse ${file}: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(parsed?.appliesTo)) {
    console.error(
      `[emit-contracts] ${file} has no appliesTo array — refusing to emit a broken sidecar.`,
    );
    process.exit(1);
  }
  if (parsed.appliesTo.includes(SDK_IDENTIFIER)) {
    matchingContracts.push({ ...parsed, bundledIn });
  }
}

matchingContracts.sort((a, b) => a.id.localeCompare(b.id));

const payload = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  generatedAt: new Date().toISOString(),
  sdk: `@cross-deck/${SDK_IDENTIFIER}`,
  sdkVersion,
  bundledIn,
  count: matchingContracts.length,
  contracts: matchingContracts,
};

fs.writeFileSync(target, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(
  `[emit-contracts] wrote ${matchingContracts.length} contract entries (appliesTo includes "${SDK_IDENTIFIER}") to dist/contracts.json`,
);
