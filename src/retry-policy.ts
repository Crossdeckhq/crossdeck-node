/**
 * Retry policy for the event-queue flush.
 *
 * After a failed flush, the queue must wait some time before trying
 * again — otherwise a flapping backend causes a hot loop, and a 429
 * "slow down" goes ignored.
 *
 * Policy (parity with `@cross-deck/web/src/retry-policy.ts`):
 *   - Exponential backoff: `base * 2^attempts`, capped at `maxMs`.
 *   - Full jitter: result is multiplied by `Math.random()` so 100 SDK
 *     instances retrying the same downed endpoint don't all hammer at
 *     the same instant. Spread the storm.
 *   - 429 / 503 `Retry-After`: ALWAYS honour the server-supplied delay
 *     when it's larger than our computed backoff. The server knows its
 *     own capacity better than we do; ignoring it is what gets your IP
 *     blocked.
 *   - Reset on success.
 *
 * The policy is a pure object — no state mutation outside `attempts`,
 * no timers. The EventQueue owns the timer; the policy owns the math.
 *
 * Default values match Stripe-style retry windows:
 *   - baseMs: 1000  (first retry ~1s out, jittered to 0-1s)
 *   - maxMs: 60000  (never wait longer than 60s)
 *   - factor: 2     (1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, …)
 *
 * After `failuresBeforeWarn` (default 8) without a success, the caller
 * is expected to surface that as a `lastError` for the developer to see
 * in diagnostics. We never stop retrying — events matter and a transient
 * outage can take hours — but we report it clearly so the dev knows
 * their data is queued, not lost.
 */

export interface RetryPolicyOptions {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  /** Number of consecutive failures before flagging diagnostics. Default 8. */
  failuresBeforeWarn?: number;
}

const DEFAULT_BASE = 1000;
const DEFAULT_MAX = 60_000;
const DEFAULT_FACTOR = 2;
const DEFAULT_WARN = 8;

/**
 * Compute the next retry delay (ms) given the consecutive-failure count
 * and an optional server-supplied `Retry-After` (ms).
 *
 *   computeNextDelay(0, undefined)              → ~500ms (jittered 0-1000)
 *   computeNextDelay(3, undefined)              → ~4s    (jittered 0-8000)
 *   computeNextDelay(0, 30_000)                 → 30s    (server wins)
 *   computeNextDelay(8, undefined)              → 60s    (capped)
 *
 * Pure function — exported for unit testing. Real callers go through
 * `RetryPolicy.nextDelay` so option defaults stay co-located.
 */
export function computeNextDelay(
  attempts: number,
  retryAfterMs: number | undefined,
  options: RetryPolicyOptions = {},
  random: () => number = Math.random,
): number {
  const base = options.baseMs ?? DEFAULT_BASE;
  const max = options.maxMs ?? DEFAULT_MAX;
  const factor = options.factor ?? DEFAULT_FACTOR;

  // Cap attempts so 2^attempts doesn't overflow into Infinity.
  const safeAttempts = Math.min(attempts, 30);
  const ceiling = Math.min(max, base * Math.pow(factor, safeAttempts));
  // Full jitter: random across [0, ceiling]. Caller can substitute a
  // deterministic RNG for testing.
  const jittered = ceiling * random();
  // Honour server's Retry-After when bigger than our window — the
  // server's the authority on its own pressure.
  if (retryAfterMs !== undefined && retryAfterMs > jittered) {
    return Math.min(max, retryAfterMs);
  }
  return Math.max(0, Math.round(jittered));
}

export class RetryPolicy {
  private attempts = 0;
  constructor(private readonly options: RetryPolicyOptions = {}) {}

  /** How many consecutive failures since the last success. */
  get consecutiveFailures(): number {
    return this.attempts;
  }

  /** Whether we've crossed the failuresBeforeWarn threshold. */
  get isWarning(): boolean {
    return this.attempts >= (this.options.failuresBeforeWarn ?? DEFAULT_WARN);
  }

  /** Schedule-time delay for the NEXT retry. Increments the counter. */
  nextDelay(retryAfterMs?: number, random: () => number = Math.random): number {
    const delay = computeNextDelay(this.attempts, retryAfterMs, this.options, random);
    this.attempts += 1;
    return delay;
  }

  /** Mark a successful flush — reset the counter. */
  recordSuccess(): void {
    this.attempts = 0;
  }
}
