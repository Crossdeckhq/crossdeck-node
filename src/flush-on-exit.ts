/**
 * Process-exit drain hook.
 *
 * Defends against the silent-loss failure mode that motivated the
 * entire v1.0.0 port: a Cloud Function cold-starts, fires 3 events
 * synchronously, and the process exits before the HTTP POSTs complete.
 * Without this module, those events vanish without trace.
 *
 * With it, we install handlers for `beforeExit` + `SIGTERM` + `SIGINT`
 * that synchronously await `queue.flush()` before the process is
 * allowed to terminate. Bounded by `timeoutMs` (default 2000ms) so a
 * misbehaving server can't keep the function alive past the platform's
 * SIGKILL window (typically 5-10s after SIGTERM).
 *
 * Idempotency:
 *   - `install()` returns immediately if already installed.
 *   - Multiple signals (e.g. SIGTERM then beforeExit) only drain once.
 *   - `uninstall()` removes the listeners.
 *
 * Why not just rely on `process.on('exit')`: by the time 'exit' fires,
 * the event loop is dead. No async work can run. `beforeExit` is the
 * last point at which the loop is still alive and we can `await
 * flush()` properly. SIGTERM + SIGINT are the platform's "you're being
 * terminated" signals — Cloud Run fires SIGTERM on container stop;
 * Lambda fires SIGTERM on idle termination; SIGINT is the user's
 * Ctrl-C in dev.
 */

export interface FlushOnExitOptions {
  /**
   * Async drain function — typically `() => server.flush()`. May reject
   * or hang; we bound it with `timeoutMs`.
   */
  drain: () => Promise<unknown>;
  /**
   * Bounded timeout for the drain (ms). Default 2000.
   *
   * Two seconds is enough to flush a handful of events over a healthy
   * network without holding up function teardown past the platform's
   * SIGKILL window.
   */
  timeoutMs?: number;
  /**
   * Optional callback fired when the drain starts. Wired by the SDK
   * debug logger to emit `sdk.flush_on_exit_started`.
   */
  onStart?: () => void;
  /**
   * Optional callback fired when the drain completes (success or
   * timeout). Wired by the SDK debug logger to emit
   * `sdk.flush_on_exit_completed`. Receives `{ durationMs, timedOut }`.
   */
  onComplete?: (info: { durationMs: number; timedOut: boolean }) => void;
  /**
   * Optional callback fired when the drain throws. Receives the error.
   * The handler always allows the process to exit — drain failure is
   * observation, not a block.
   */
  onError?: (err: unknown) => void;
}

type Signal = "SIGTERM" | "SIGINT";
const SIGNALS: readonly Signal[] = ["SIGTERM", "SIGINT"];

const DEFAULT_TIMEOUT_MS = 2000;

export class FlushOnExit {
  private installed = false;
  private draining = false;
  private drained = false;
  private beforeExitHandler: (() => void) | null = null;
  private signalHandlers: Partial<Record<Signal, () => void>> = {};

  constructor(private readonly options: FlushOnExitOptions) {}

  /**
   * Install handlers for `beforeExit` + `SIGTERM` + `SIGINT`. Idempotent —
   * calling twice does NOT register duplicate handlers.
   */
  install(): void {
    if (this.installed) return;
    this.installed = true;

    this.beforeExitHandler = () => {
      // `beforeExit` fires when the event loop has no more work AND
      // there's no async pending. We're allowed to start more async
      // here — the loop will re-tick to drain it. After we return
      // from awaiting drain, `beforeExit` will NOT re-fire (Node
      // guards against re-entry).
      void this.runDrain("beforeExit");
    };
    process.on("beforeExit", this.beforeExitHandler);

    for (const sig of SIGNALS) {
      const handler = (): void => {
        void this.runDrainAndExit(sig);
      };
      this.signalHandlers[sig] = handler;
      process.on(sig, handler);
    }
  }

  /**
   * Remove all handlers. Tests + custom-lifecycle callers only.
   */
  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    if (this.beforeExitHandler) {
      process.off("beforeExit", this.beforeExitHandler);
      this.beforeExitHandler = null;
    }
    for (const sig of SIGNALS) {
      const handler = this.signalHandlers[sig];
      if (handler) {
        process.off(sig, handler);
        delete this.signalHandlers[sig];
      }
    }
  }

  /**
   * Force-drain immediately (without waiting for an exit signal).
   * Used by `wrapLambdaHandler` / `wrapFunction` — Lambda freezes the
   * process between invocations, so we drain at the END of each
   * invocation rather than waiting for SIGTERM.
   */
  async drainNow(): Promise<void> {
    return this.runDrain("manual");
  }

  /** True if the drain has already completed (one-shot lifecycle). */
  get hasDrained(): boolean {
    return this.drained;
  }

  /** True if a drain is in flight. */
  get isDraining(): boolean {
    return this.draining;
  }

  // ---------- internals ----------

  private async runDrain(_reason: "beforeExit" | "SIGTERM" | "SIGINT" | "manual"): Promise<void> {
    // One-shot — multiple signals during the same process must not
    // double-drain. The queue has been spliced empty after the first
    // call; subsequent flushes would be no-ops, but we also have to
    // worry about a race where two signals fire in quick succession.
    if (this.drained || this.draining) return;
    this.draining = true;
    this.options.onStart?.();

    const start = Date.now();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    let drainError: unknown = null;

    // Race the drain against the timeout. The drain's rejection is
    // surfaced via `drainError` (not by rethrowing) so we can ALWAYS
    // fire `onComplete` and ALWAYS fire `onError` when the drain
    // threw — and never leave the process hanging on a swallowed
    // rejection.
    await new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        timedOut = true;
        resolve();
      }, timeoutMs);
      // `.unref()` so the timer itself doesn't keep the loop alive
      // past the drain — otherwise a fast drain would still wait the
      // full timeout before letting `beforeExit` complete.
      if (typeof timer.unref === "function") {
        try {
          timer.unref();
        } catch {
          // ignore
        }
      }

      let drainPromise: Promise<unknown>;
      try {
        drainPromise = this.options.drain();
      } catch (syncErr) {
        // The drain function threw synchronously before returning a
        // promise. Treat the same as an async rejection.
        if (settled) return;
        settled = true;
        drainError = syncErr;
        clearTimeout(timer);
        resolve();
        return;
      }

      drainPromise.then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        (err) => {
          if (settled) return;
          settled = true;
          drainError = err;
          clearTimeout(timer);
          resolve();
        },
      );
    });

    if (drainError !== null) {
      try {
        this.options.onError?.(drainError);
      } catch {
        // A buggy onError must NOT block process exit.
      }
    }

    this.draining = false;
    this.drained = true;
    this.options.onComplete?.({
      durationMs: Date.now() - start,
      timedOut,
    });
  }

  /**
   * Drain in response to a termination signal. After the drain
   * completes, we re-raise the signal so the process exits with the
   * correct exit code — `kill -TERM <pid>` should still terminate
   * the process even though we installed a handler that "consumed" it.
   *
   * Detail: Node attaches a default SIGTERM handler that exits the
   * process. The MOMENT we register our own handler with `process.on`,
   * the default is removed. So we have to re-raise to mimic the
   * default behaviour after our drain completes.
   */
  private async runDrainAndExit(sig: Signal): Promise<void> {
    await this.runDrain(sig);
    // Remove our handler so the re-raised signal hits the default.
    const handler = this.signalHandlers[sig];
    if (handler) {
      process.off(sig, handler);
      delete this.signalHandlers[sig];
    }
    // Re-raise. Exit code convention: 128 + signal number (SIGTERM=15
    // → 143; SIGINT=2 → 130). Node's process.kill() does this for us.
    try {
      process.kill(process.pid, sig);
    } catch {
      // Defensive: process.kill can fail if pid is somehow invalid.
      // Fall back to a hard exit with the conventional code.
      const code = sig === "SIGTERM" ? 143 : 130;
      process.exit(code);
    }
  }
}

