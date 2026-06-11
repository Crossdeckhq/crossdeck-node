/**
 * Schema-lock test for `crossdeck.contract_failed` (Node server SDK).
 *
 * See sdks/web/tests/contract-failed-schema-lock.test.ts for the
 * full rationale — same guards apply, same independent-controller
 * legitimate-interest basis depends on the same structural defence.
 */

import { describe, it, expect } from "vitest";
import {
  DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS,
  DIAGNOSTIC_TELEMETRY_ENDPOINT,
  filterDiagnosticPayload,
} from "../src/_diagnostic-telemetry";
import { BUNDLED_CONTRACTS } from "../src/_contracts-bundled";

// The schema-lock contract ships INSIDE the SDK — `_contracts-bundled.ts`
// is generated at build time from
// contracts/diagnostics/contract-failed-payload-schema-lock.json. Read
// the SHIPPED copy, not the monorepo source path: `../../../contracts/`
// exists in the monorepo but NOT in the standalone published repo (the
// mirror ships only the SDK), so the old require() broke the publish
// workflow's test gate. Reading the bundled copy keeps this test
// self-contained within the package and tests exactly what customers get.
interface SchemaLockFields {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly forbidden: readonly string[];
}
const contract = BUNDLED_CONTRACTS.find(
  (c) => c.id === "contract-failed-payload-schema-lock",
) as ((typeof BUNDLED_CONTRACTS)[number] & { allowedFields: SchemaLockFields }) | undefined;

if (!contract) {
  throw new Error(
    "bundled contract 'contract-failed-payload-schema-lock' missing — run `npm run build` to regenerate src/_contracts-bundled.ts",
  );
}

describe("contract-failed schema-lock — Node", () => {
  it("DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS matches required ∪ optional", () => {
    const fromContract = new Set<string>([
      ...contract.allowedFields.required,
      ...contract.allowedFields.optional,
    ]);
    expect(new Set(DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS)).toEqual(fromContract);
  });

  it("DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS does not contain any forbidden field", () => {
    for (const forbidden of contract.allowedFields.forbidden) {
      expect(DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS.has(forbidden)).toBe(false);
    }
  });

  it("reportContractFailure payload conforms to schema-lock", () => {
    const filtered = filterDiagnosticPayload({
      contract_id: "test-contract",
      sdk_version: "1.0.0",
      sdk_platform: "node",
      failure_reason: "test failure",
      run_context: "ci",
      run_id: "run_123",
      // Forbidden — must be stripped.
      anonymousId: "anon_12345",
      ip: "10.0.0.1",
      email: "user@example.com",
      stack_trace: "Error\n  at foo (bar.js:1:1)",
      message: "internal: divide by zero",
    } as Record<string, string>);
    for (const forbidden of contract.allowedFields.forbidden) {
      expect(filtered).not.toHaveProperty(forbidden);
    }
    for (const required of contract.allowedFields.required) {
      expect(filtered).toHaveProperty(required);
    }
  });

  it("endpoint URL is the reliability endpoint, not customer events", () => {
    expect(DIAGNOSTIC_TELEMETRY_ENDPOINT).toBe(
      "https://api.cross-deck.com/v1/sdk/diagnostic",
    );
    expect(DIAGNOSTIC_TELEMETRY_ENDPOINT).not.toContain("/v1/events");
  });
});
