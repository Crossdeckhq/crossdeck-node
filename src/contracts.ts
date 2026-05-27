/**
 * Public, typed accessor for the bank-grade behavioural contracts
 * this SDK ships. The full architecture — schema, distribution,
 * audit loop, pillar taxonomy — lives in `contracts/README.md`
 * at the monorepo root.
 *
 * Why a typed surface (vs. plain JSON access): contract IDs and
 * pillar names are part of Crossdeck's public commitment to
 * customers. Reading them through `CrossdeckContracts` means the
 * compiler catches drift the moment a contract is renamed or
 * retired. Tools that consume contracts at runtime (dashboards,
 * AI assistants, customer integration tests) get the exact same
 * shape every SDK ships, with no parsing layer to drift.
 *
 * --- BINARY STABILITY ---
 * `Contract` is treated as an evolving — but back-compat — wire
 * shape. Fields may be added in any minor release. Existing
 * fields will not be removed or repurposed except in a major
 * version bump, even if all known contracts stop using them.
 * Customers can rely on `id`, `pillar`, `status`, `appliesTo`,
 * `codeRef`, `testRef`, `registeredAt`, `firstRegisteredIn`,
 * and `bundledIn` being present on every contract in every
 * future minor/patch release of this SDK.
 */

import {
  BUNDLED_CONTRACTS,
  BUNDLED_IN,
  SDK_VERSION,
} from "./_contracts-bundled";

export type ContractPillar =
  | "revenue"
  | "entitlements"
  | "analytics"
  | "webhooks"
  | "errors"
  | "lifecycle"
  | "identity";

export type ContractStatus = "enforced" | "proposed" | "retired";

export type ContractAppliesTo =
  | "web"
  | "node"
  | "react-native"
  | "swift"
  | "android"
  | "backend";

export interface ContractTestRef {
  readonly file: string;
  readonly name: string;
}

export interface Contract {
  readonly id: string;
  readonly pillar: ContractPillar;
  readonly status: ContractStatus;
  readonly claim: string;
  readonly appliesTo: readonly ContractAppliesTo[];
  readonly codeRef: readonly string[];
  readonly testRef: readonly ContractTestRef[];
  readonly registeredAt: string;
  readonly firstRegisteredIn: string;
  readonly bundledIn: string;
}

/**
 * Typed entry point to the bank-grade contracts bundled with this
 * SDK release. Stable, side-effect-free, tree-shakeable.
 *
 * @example Audit at app boot
 * ```ts
 * import { CrossdeckContracts } from "@cross-deck/node";
 *
 * for (const c of CrossdeckContracts.all()) {
 *   console.log(`[crossdeck] ${c.id} (${c.pillar})`);
 * }
 * ```
 */
export const CrossdeckContracts = {
  all(): readonly Contract[] {
    return BUNDLED_CONTRACTS.filter((c) => c.status === "enforced");
  },
  allIncludingHistorical(): readonly Contract[] {
    return BUNDLED_CONTRACTS;
  },
  byId(id: string): Contract | undefined {
    return BUNDLED_CONTRACTS.find((c) => c.id === id);
  },
  byPillar(pillar: ContractPillar): readonly Contract[] {
    return BUNDLED_CONTRACTS.filter(
      (c) => c.pillar === pillar && c.status === "enforced",
    );
  },
  withStatus(status: ContractStatus): readonly Contract[] {
    return BUNDLED_CONTRACTS.filter((c) => c.status === status);
  },
  sdkVersion: SDK_VERSION,
  bundledIn: BUNDLED_IN,

  /**
   * Resolve a failing test back to the contract it exercises.
   * Used by test-framework hooks to find the contract id of a
   * failed contract test so `reportContractFailure(...)` can stamp
   * the right `contract_id` on the emitted event.
   */
  findByTestName(name: string): Contract | undefined {
    return BUNDLED_CONTRACTS.find((c) =>
      c.testRef.some((ref) => ref.name === name),
    );
  },
} as const;

/**
 * Input to {@link CrossdeckServer.reportContractFailure}. Mirrors
 * the per-SDK shape exactly.
 *
 * SCHEMA-LOCK: this interface's field set is exhaustively named. No
 * free-form `extra: Record<string, unknown>` — the schema-lock
 * contract at
 * `contracts/diagnostics/contract-failed-payload-schema-lock.json`
 * forbids unbounded fields. Adding a field requires a PR that
 * amends the contract first, then the public interface.
 */
export interface ContractFailureInput {
  contractId: string;
  /**
   * Short categorical-ish label — the SDK convention is to keep
   * this under 128 chars and stable across runs (so dashboards can
   * group). Never an end-user-supplied string.
   */
  failureReason: string;
  runContext: "ci" | "dogfood" | "customer-app";
  runId: string;
  testRef?: { file: string; name: string };
  /**
   * Optional coarse device class, e.g. "linux-server", "container",
   * "lambda". A categorical bucket, not a host identifier.
   */
  deviceClass?: string;
}
