export { CrossdeckServer } from "./crossdeck-server";
export { CrossdeckError } from "./errors";
export {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  SDK_NAME,
  SDK_VERSION,
} from "./http";

export type {
  AliasIdentityInput,
  AliasResult,
  AuditDecision,
  AuditEntry,
  CrossdeckServerOptions,
  EntitlementMutationResult,
  EntitlementsListResponse,
  Environment,
  ForgetResult,
  GrantDuration,
  GrantEntitlementInput,
  IdentityHints,
  IdentifyOptions,
  IngestOptions,
  IngestResponse,
  PublicEntitlement,
  RevokeEntitlementInput,
  ServerEvent,
  SyncPurchaseInput,
  ErrorLevel,
} from "./types";
export type { CrossdeckErrorPayload, CrossdeckErrorType } from "./errors";
