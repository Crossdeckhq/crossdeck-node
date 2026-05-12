import { randomUUID } from "node:crypto";

import { CrossdeckError } from "./errors";
import { validateEventProperties } from "./event-validation";
import {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  HttpClient,
  SDK_NAME,
  SDK_VERSION,
} from "./http";
import type {
  AliasIdentityInput,
  AliasResult,
  AuditEntry,
  AuditEntryResponse,
  CrossdeckServerOptions,
  EntitlementMutationResult,
  EntitlementsListResponse,
  ForgetResult,
  GrantEntitlementInput,
  IdentityHints,
  IdentifyOptions,
  IngestOptions,
  IngestResponse,
  PurchaseResult,
  RevokeEntitlementInput,
  ServerEvent,
  SyncPurchaseInput,
} from "./types";

export class CrossdeckServer {
  private readonly http: HttpClient;
  private readonly sdkVersion: string;
  private readonly appId?: string;

  constructor(options: CrossdeckServerOptions) {
    if (!options.secretKey || !options.secretKey.startsWith("cd_sk_")) {
      throw new CrossdeckError({
        type: "configuration_error",
        code: "invalid_secret_key",
        message: "CrossdeckServer requires a secret key starting with cd_sk_.",
      });
    }

    this.sdkVersion = options.sdkVersion ?? SDK_VERSION;
    this.appId = options.appId;
    this.http = new HttpClient({
      secretKey: options.secretKey,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      sdkVersion: this.sdkVersion,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  async identify(
    userId: string,
    anonymousId: string,
    options?: IdentifyOptions,
  ): Promise<AliasResult> {
    return this.aliasIdentity({ userId, anonymousId, ...options });
  }

  async aliasIdentity(input: AliasIdentityInput): Promise<AliasResult> {
    if (!input.userId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_user_id",
        message: "aliasIdentity requires a non-empty userId.",
      });
    }
    if (!input.anonymousId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_anonymous_id",
        message: "aliasIdentity requires a non-empty anonymousId.",
      });
    }

    const traits = sanitizePropertyBag(input.traits, "traits");
    const body: Record<string, unknown> = {
      userId: input.userId,
      anonymousId: input.anonymousId,
    };
    if (input.email) body.email = input.email;
    if (traits && Object.keys(traits).length > 0) body.traits = traits;

    return this.http.request<AliasResult>("POST", "/identity/alias", { body });
  }

  async forget(hints: IdentityHints): Promise<ForgetResult> {
    const body = this.identityPayload(hints);
    return this.http.request<ForgetResult>("POST", "/identity/forget", { body });
  }

  async getEntitlements(hints: IdentityHints): Promise<EntitlementsListResponse> {
    return this.http.request<EntitlementsListResponse>("GET", "/entitlements", {
      query: this.identityPayload(hints),
    });
  }

  async getCustomerEntitlements(customerId: string): Promise<EntitlementsListResponse> {
    if (!customerId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_customer_id",
        message: "getCustomerEntitlements requires a customerId.",
      });
    }
    return this.http.request<EntitlementsListResponse>(
      "GET",
      `/server/customers/${encodeURIComponent(customerId)}/entitlements`,
    );
  }

  async track(event: ServerEvent, options: IngestOptions = {}): Promise<IngestResponse> {
    return this.ingest([event], options);
  }

  async ingest(events: ServerEvent[], options: IngestOptions = {}): Promise<IngestResponse> {
    if (!Array.isArray(events) || events.length === 0) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_events",
        message: "ingest requires at least one event.",
      });
    }

    const normalized = events.map((event) => this.normalizeEvent(event));
    const body: Record<string, unknown> = {
      events: normalized,
      sdk: { name: SDK_NAME, version: this.sdkVersion },
    };
    if (this.appId) body.appId = this.appId;

    return this.http.request<IngestResponse>("POST", "/events", {
      body,
      idempotencyKey: options.idempotencyKey ?? this.mintBatchId(),
    });
  }

  async syncPurchases(input: SyncPurchaseInput): Promise<PurchaseResult> {
    if (!input.signedTransactionInfo) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_signed_transaction_info",
        message: "syncPurchases requires a signedTransactionInfo string.",
      });
    }
    return this.http.request<PurchaseResult>("POST", "/purchases/sync", {
      body: { rail: input.rail ?? "apple", ...input },
    });
  }

  async grantEntitlement(
    input: GrantEntitlementInput,
  ): Promise<EntitlementMutationResult> {
    if (!input.customerId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_customer_id",
        message: "grantEntitlement requires a customerId.",
      });
    }

    return this.http.request<EntitlementMutationResult>(
      "POST",
      `/server/customers/${encodeURIComponent(input.customerId)}/grant`,
      {
        body: {
          entitlementKey: input.entitlementKey,
          duration: input.duration,
          reason: input.reason,
        },
      },
    );
  }

  async revokeEntitlement(
    input: RevokeEntitlementInput,
  ): Promise<EntitlementMutationResult> {
    if (!input.customerId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_customer_id",
        message: "revokeEntitlement requires a customerId.",
      });
    }

    return this.http.request<EntitlementMutationResult>(
      "POST",
      `/server/customers/${encodeURIComponent(input.customerId)}/revoke`,
      {
        body: {
          entitlementKey: input.entitlementKey,
          reason: input.reason,
        },
      },
    );
  }

  async getAuditEntry(eventId: string): Promise<AuditEntry> {
    if (!eventId) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_event_id",
        message: "getAuditEntry requires an eventId.",
      });
    }

    const result = await this.http.request<AuditEntryResponse>(
      "GET",
      `/server/audit/${encodeURIComponent(eventId)}`,
    );
    return result.data;
  }

  private identityPayload(hints: IdentityHints): Record<string, string> {
    const payload: Record<string, string> = {};
    if (typeof hints.customerId === "string" && hints.customerId) {
      payload.customerId = hints.customerId;
    }
    if (typeof hints.userId === "string" && hints.userId) {
      payload.userId = hints.userId;
    }
    if (typeof hints.anonymousId === "string" && hints.anonymousId) {
      payload.anonymousId = hints.anonymousId;
    }
    if (Object.keys(payload).length === 0) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_identity",
        message: "Provide at least one of customerId, userId, or anonymousId.",
      });
    }
    return payload;
  }

  private normalizeEvent(event: ServerEvent): ServerEvent {
    if (!event.name) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_event_name",
        message: "Each event requires a non-empty name.",
      });
    }
    const hasIdentity =
      Boolean(event.developerUserId) ||
      Boolean(event.anonymousId) ||
      Boolean(event.crossdeckCustomerId);
    if (!hasIdentity) {
      throw new CrossdeckError({
        type: "invalid_request_error",
        code: "missing_identity",
        message:
          "Each event requires at least one of developerUserId, anonymousId, or crossdeckCustomerId.",
      });
    }
    const properties = sanitizePropertyBag(event.properties, "event properties");
    return {
      ...event,
      properties,
      eventId: event.eventId ?? this.mintEventId(),
      timestamp: event.timestamp ?? Date.now(),
    };
  }

  private mintEventId(): string {
    const ts = Date.now().toString(36);
    return `evt_${ts}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  }

  private mintBatchId(): string {
    const ts = Date.now().toString(36);
    return `batch_${ts}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  }
}

function sanitizePropertyBag(
  input: Record<string, unknown> | undefined,
  fieldName: string,
): Record<string, unknown> | undefined {
  if (input === undefined) return undefined;
  try {
    return validateEventProperties(input).properties;
  } catch {
    throw new CrossdeckError({
      type: "invalid_request_error",
      code: "serialization_failed",
      message: `${fieldName} could not be serialized.`,
    });
  }
}
