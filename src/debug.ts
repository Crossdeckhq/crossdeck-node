/**
 * Debug signal vocabulary — NorthStar §16, Node port of
 * `@cross-deck/web/src/debug.ts`.
 *
 * The SDK speaks a small fixed vocabulary of signals so the dashboard's
 * onboarding checklist and the developer's console output both speak
 * the same words. When `debug: true` is set in `CrossdeckServerOptions`,
 * the signals are also logged to `console.info` so a developer doing
 * copy-paste integration sees actionable feedback live.
 *
 * Signal names are STABLE — adding new ones is fine, renaming is a
 * breaking change because the dashboard onboarding step keys off them.
 *
 * Node-specific additions beyond web's vocabulary:
 *   - `sdk.flush_on_exit_started` / `sdk.flush_on_exit_completed`
 *   - `sdk.webhook_verified`
 *   - `sdk.runtime_detected`
 *   - `sdk.entitlement_cache_warm`
 *   - `sdk.entitlement_cache_stale`
 *   - `sdk.entitlement_store_recovered`
 *   - `sdk.no_durable_store`
 *   - `sdk.super_property_registered`
 */

export type DebugSignal =
  | "sdk.configured"
  | "sdk.first_event_sent"
  | "sdk.invalid_key"
  | "sdk.no_identity"
  | "sdk.entitlement_cache_used"
  | "sdk.entitlement_cache_warm"
  | "sdk.entitlement_cache_stale"
  | "sdk.entitlement_store_recovered"
  | "sdk.no_durable_store"
  | "sdk.purchase_evidence_sent"
  | "sdk.environment_mismatch"
  | "sdk.sensitive_property_warning"
  | "sdk.property_coerced"
  | "sdk.flush_retry_scheduled"
  | "sdk.flush_on_exit_started"
  | "sdk.flush_on_exit_completed"
  | "sdk.webhook_verified"
  | "sdk.runtime_detected"
  | "sdk.super_property_registered"
  | "sdk.boot_heartbeat_failed";

export interface DebugContext {
  [key: string]: unknown;
}

/**
 * Names that almost always indicate PII or secret data. Used by
 * `track()` to warn the developer when a property key looks dangerous.
 * Per NorthStar §15 these are reject/warn-on-sight values; we warn
 * rather than reject because the developer might genuinely want a
 * property called e.g. "tokens_remaining".
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /^email$/i,
  /^password$/i,
  /^token$/i,
  /^secret$/i,
  /^card$/i,
  /^phone$/i,
  /password/i,
  /credit_?card/i,
];

export function findSensitivePropertyKeys(
  properties: Record<string, unknown> | undefined,
): string[] {
  if (!properties) return [];
  const hits: string[] = [];
  for (const k of Object.keys(properties)) {
    if (SENSITIVE_KEY_PATTERNS.some((re) => re.test(k))) hits.push(k);
  }
  return hits;
}

export interface DebugLogger {
  enabled: boolean;
  emit(signal: DebugSignal, message: string, context?: DebugContext): void;
}

const ONCE_SIGNALS = new Set<DebugSignal>([
  "sdk.configured",
  "sdk.first_event_sent",
  "sdk.environment_mismatch",
  "sdk.runtime_detected",
]);

/**
 * Default debug logger. Writes to `console.info` with a
 * `[crossdeck:<signal>]` prefix so a developer grepping their logs can
 * find SDK signals quickly. Inactive when `enabled === false` — the
 * SDK constructs the logger regardless so a runtime `setDebugMode(true)`
 * doesn't require re-wiring.
 *
 * One-shot signals (sdk.configured, sdk.first_event_sent,
 * sdk.environment_mismatch, sdk.runtime_detected) deduplicate within
 * a process lifetime so a chatty app doesn't spam the console with
 * the same message.
 */
export class ConsoleDebugLogger implements DebugLogger {
  enabled = false;
  private seen = new Set<DebugSignal>();

  emit(signal: DebugSignal, message: string, context?: DebugContext): void {
    if (!this.enabled) return;
    if (ONCE_SIGNALS.has(signal)) {
      if (this.seen.has(signal)) return;
      this.seen.add(signal);
    }
    const ctx = context ? ` ${safeJson(context)}` : "";
    // eslint-disable-next-line no-console
    console.info(`[crossdeck:${signal}] ${message}${ctx}`);
  }
}

/**
 * No-op logger for tests + callers that want the SDK to be 100% silent.
 * Constructed when `debug` is unset and no custom logger is supplied;
 * the SDK calls `emit()` on every signal regardless of the runtime
 * `enabled` state, so a permanently-off logger keeps the hot path
 * branch-free.
 */
export class NullDebugLogger implements DebugLogger {
  enabled = false;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  emit(_signal: DebugSignal, _message: string, _context?: DebugContext): void {
    /* no-op */
  }
}

function safeJson(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return "[unserialisable context]";
  }
}
