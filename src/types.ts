export type Environment = "production" | "sandbox";
export type AuditRail = "apple" | "stripe" | "google" | "manual";

export interface PublicEntitlement {
  object: "entitlement";
  key: string;
  isActive: boolean;
  validUntil?: number | null;
  source: {
    rail: AuditRail;
    productId: string;
    subscriptionId: string;
  };
  updatedAt: number;
}

export interface EntitlementsListResponse {
  object: "list";
  data: PublicEntitlement[];
  crossdeckCustomerId: string;
  env: Environment;
}

export interface AliasResult {
  object: "alias_result";
  crossdeckCustomerId: string;
  linked: Array<
    | { type: "developer"; id: string }
    | { type: "anonymous"; id: string }
  >;
  mergePending: boolean;
  env: Environment;
}

export interface IngestResponse {
  object: "list";
  received: number;
  env: Environment;
  throttled?: {
    dropped: number;
    sampleRate: number;
    retryAfterMs: number;
  };
}

export interface PurchaseResult {
  object: "purchase_result";
  crossdeckCustomerId: string;
  env: Environment;
  entitlements: PublicEntitlement[];
}

export interface ForgetResult {
  object: "forgot";
  crossdeckCustomerId: string | null;
  queuedAt: number;
  env: Environment;
}

export interface CrossdeckServerOptions {
  secretKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  sdkVersion?: string;
  /**
   * Optional informational appId stamped onto event batches. The server
   * ultimately trusts the API key's resolved app routing, so this is
   * best-effort metadata only.
   */
  appId?: string;
}

export interface IdentityHints {
  customerId?: string;
  userId?: string;
  anonymousId?: string;
}

export interface IdentifyOptions {
  email?: string;
  traits?: Record<string, unknown>;
}

export interface AliasIdentityInput extends IdentifyOptions {
  userId: string;
  anonymousId: string;
}

export type ErrorLevel = "error" | "warning" | "info";

export interface ServerEvent {
  eventId?: string;
  name: string;
  timestamp?: number;
  properties?: Record<string, unknown>;
  developerUserId?: string;
  anonymousId?: string;
  crossdeckCustomerId?: string;
  level?: ErrorLevel;
  tags?: Record<string, string>;
  categoryTags?: string[];
}

export interface IngestOptions {
  idempotencyKey?: string;
}

export interface SyncPurchaseInput {
  rail?: "apple";
  signedTransactionInfo: string;
  signedRenewalInfo?: string;
  appAccountToken?: string;
}

export type GrantDuration = "P30D" | "P90D" | "P1Y" | "lifetime";

export interface GrantEntitlementInput {
  customerId: string;
  entitlementKey: string;
  duration: GrantDuration;
  reason: string;
}

export interface RevokeEntitlementInput {
  customerId: string;
  entitlementKey: string;
  reason: string;
}

export interface EntitlementMutationResult {
  object: "entitlement_mutation";
  action: "grant" | "revoke";
  crossdeckCustomerId: string;
  entitlement: PublicEntitlement;
  env: Environment;
}

export type AuditDecision = "applied" | "no_op" | "rejected";

export interface AuditEntry {
  eventId: string;
  rail: AuditRail;
  env: Environment;
  eventType: string;
  projectId: string;
  subscriptionId?: string;
  customerId?: string;
  fromState?: string;
  toState?: string;
  decision: AuditDecision;
  reason?: string;
  derivedSignal?: string;
  signatureVerified: boolean;
  reconciledWithProvider: boolean;
  rawEventReceivedAt: number;
  processedAt: number;
}

export interface AuditEntryResponse {
  object: "audit_entry";
  data: AuditEntry;
}
