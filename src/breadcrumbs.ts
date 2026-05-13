/**
 * Breadcrumb ring buffer — context attached to every error report.
 *
 * Sentry / Datadog / Bugsnag all ship the same idea: keep a rolling
 * record of the last N "things the process did" (HTTP calls, queued
 * events, custom log lines, function invocations). When an error fires,
 * attach the buffer so the engineer reading the error can see exactly
 * how the process got into the broken state. The single most powerful
 * debugging signal in error monitoring — without breadcrumbs, errors
 * are stack traces with no story.
 *
 * Implementation: a circular buffer with a fixed cap. Old entries are
 * evicted as new ones arrive. The default cap (50) is enough to cover
 * ~5 minutes of typical request activity without ballooning the error
 * payload. Sentry uses 100 by default but the SDK is more aggressive
 * about size since we ship breadcrumbs over the wire with every error,
 * not as a separate batch.
 *
 * Verbatim port of `@cross-deck/web/src/breadcrumbs.ts`. The data
 * structure has zero browser dependencies; same code works in Node.
 *
 * Privacy: breadcrumbs from `track()` calls auto-flow through the same
 * property sanitiser (`event-validation.ts`) before reaching this
 * buffer, so a function/symbol/Error-shape in a tracked property won't
 * crash subsequent error reports.
 */

export type BreadcrumbCategory =
  | "navigation"
  | "ui.click"
  | "ui.input"
  | "http"
  | "console"
  | "custom"
  | "info";

export type BreadcrumbLevel = "debug" | "info" | "warning" | "error";

export interface Breadcrumb {
  /** epoch ms */
  timestamp: number;
  category: BreadcrumbCategory;
  level?: BreadcrumbLevel;
  /** Short human-readable description. */
  message?: string;
  /** Arbitrary key/value context for the crumb. */
  data?: Record<string, unknown>;
}

export class BreadcrumbBuffer {
  private items: Breadcrumb[] = [];
  constructor(private readonly maxSize: number = 50) {}

  add(crumb: Breadcrumb): void {
    this.items.push(crumb);
    if (this.items.length > this.maxSize) {
      this.items.shift();
    }
  }

  /** Defensive copy — caller can read freely without mutating buffer state. */
  snapshot(): Breadcrumb[] {
    return this.items.slice();
  }

  clear(): void {
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }
}
