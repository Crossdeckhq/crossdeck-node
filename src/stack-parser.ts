/**
 * Stack-trace parser — normalises V8 / Firefox / Safari stack strings
 * into a common frame shape.
 *
 * Why hand-rolled, not `stack-trace-js` / `error-stack-parser`: those
 * weigh 5–15 KB after minification and we'd be pulling in their full
 * feature matrix just for the parser. The patterns below cover the
 * three shapes any modern runtime emits, totalling ~80 lines.
 *
 * Port of `@cross-deck/web/src/stack-parser.ts`. Two differences:
 *   1. `isInAppFrame` heuristics are Node-aware (`node_modules/`,
 *      `node:` core URLs, `internal/` Node internals,
 *      `@cross-deck/node` self-skip) instead of browser-aware
 *      (extension URLs, CDN hostnames).
 *   2. Path separator handling accepts both `/` (Unix / V8 standard)
 *      and `\` (Windows native paths sometimes leak into `error.stack`
 *      on Node-for-Windows deployments).
 *
 * Defensive: never throws. An unparseable line becomes a `raw` frame
 * with just the literal text. Engineers reading errors still get the
 * raw stack as fallback.
 */

export interface StackFrame {
  /** Function name, or "?" if anonymous / unparseable. */
  function: string;
  /** Source file URL the frame ran in. Empty when unknown. */
  filename: string;
  /** 1-indexed line number, or 0 when unknown. */
  lineno: number;
  /** 1-indexed column number, or 0 when unknown. */
  colno: number;
  /**
   * True when the frame is in the app's own code (best-effort:
   * detected by URL not in node_modules/, not a node: core URL, etc.).
   * Powers the dashboard's "your code vs library code" view.
   */
  in_app: boolean;
  /** Raw line from the stack string for debugging when parse fails. */
  raw: string;
}

/**
 * Parse a stack string into an array of frames. Returns an empty
 * array when the input is unparseable — caller should always treat
 * the original `error.stack` as the source of truth for display.
 */
export function parseStack(stack: string | undefined | null): StackFrame[] {
  if (!stack || typeof stack !== "string") return [];
  const lines = stack.split("\n");
  const frames: StackFrame[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const frame = parseLine(trimmed);
    if (frame) frames.push(frame);
  }
  return frames;
}

/**
 * Parse a single stack line. Returns null for header lines like
 * "TypeError: x is not a function" (those carry no frame info).
 *
 * Patterns recognised:
 *   Chrome / Node V8:  "at functionName (file:line:col)"
 *   Chrome / Node V8:  "at file:line:col"            (anonymous)
 *   Firefox / Safari:  "functionName@file:line:col"
 */
function parseLine(line: string): StackFrame | null {
  // Chrome / Node V8 — with parens
  // Example: at Object.handleRequest (file:///app/server.js:42:18)
  // Example: at Object.handleRequest (/app/server.js:42:18)
  let m = /^at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/.exec(line);
  if (m) {
    return buildFrame({
      function: m[1]!,
      filename: m[2]!,
      lineno: parseInt(m[3]!, 10),
      colno: parseInt(m[4]!, 10),
      raw: line,
    });
  }

  // Chrome / Node V8 — anonymous, no parens
  // Example: at /app/server.js:42:18
  m = /^at\s+(.+?):(\d+):(\d+)$/.exec(line);
  if (m) {
    return buildFrame({
      function: "?",
      filename: m[1]!,
      lineno: parseInt(m[2]!, 10),
      colno: parseInt(m[3]!, 10),
      raw: line,
    });
  }

  // Firefox / Safari — also emitted by some Node test runners
  // Example: handleRequest@/app/server.js:42:18
  m = /^(.*?)@(.+?):(\d+):(\d+)$/.exec(line);
  if (m) {
    return buildFrame({
      function: m[1]! || "?",
      filename: m[2]!,
      lineno: parseInt(m[3]!, 10),
      colno: parseInt(m[4]!, 10),
      raw: line,
    });
  }

  // Header line ("TypeError: foo is not a function") — return null
  // so caller skips it. Catches anything starting with a *Error word
  // OR any line that has no colon at all (genuine frames always do).
  if (/^\w*Error/.test(line) || !line.includes(":")) {
    return null;
  }

  // Unparseable but plausibly a frame — keep it as raw.
  return {
    function: "?",
    filename: "",
    lineno: 0,
    colno: 0,
    in_app: true,
    raw: line,
  };
}

function buildFrame(input: {
  function: string;
  filename: string;
  lineno: number;
  colno: number;
  raw: string;
}): StackFrame {
  return {
    function: input.function || "?",
    filename: input.filename,
    lineno: Number.isFinite(input.lineno) ? input.lineno : 0,
    colno: Number.isFinite(input.colno) ? input.colno : 0,
    in_app: isInAppFrame(input.filename),
    raw: input.raw,
  };
}

/**
 * "Is this frame in the app's own code or a third-party source we
 * should de-emphasise in the UI."
 *
 * Node-aware heuristics:
 *   1. SDK self-skip — any frame containing `@cross-deck/node`. Defends
 *      against the cycle where the SDK reports on itself.
 *   2. node_modules — library code, almost never the app's bug.
 *   3. `node:` core modules (Node 16+) — `node:fs`, `node:http`, etc.
 *   4. `internal/` — Node-internal V8 frames like
 *      `internal/process/task_queues.js`.
 *   5. Empty filename — anonymous frame, let it through as in_app.
 *
 * Path separator handling: V8 always emits `/` on all platforms, but
 * Windows-native paths can leak into `error.stack` via re-thrown
 * errors in Node-for-Windows deployments. We match both.
 */
function isInAppFrame(filename: string): boolean {
  if (!filename) return true;
  // SDK self-skip — must come before node_modules check because the
  // package's own frames live under node_modules/@cross-deck/node
  // when installed, but ALSO want to skip when running from sdks/node/src
  // during dogfood/dev.
  if (/@cross-deck[\\/]node/.test(filename)) return false;
  // Library code from any node_modules tree (root or nested).
  if (/[\\/]node_modules[\\/]/.test(filename)) return false;
  // Node 16+ core module URLs.
  if (/^node:/.test(filename)) return false;
  // Older Node / V8-internal frames.
  if (/^internal[\\/]/.test(filename)) return false;
  return true;
}

/**
 * Fingerprint an error for grouping. SHA-flavoured — we don't need
 * cryptographic strength, we need "two errors with the same call site
 * produce the same key". The Crossdeck backend may refine the grouping
 * further once source maps are uploaded.
 *
 * Input: the message + the first ≤3 in-app frames. When no frames
 * are available (non-Error throws of primitives, unhandledRejection
 * of a value with no stack), the optional `location` fallback
 * contributes filename/lineno/errorType so otherwise-identical
 * generic messages from different call sites stay separate. Without
 * the fallback they all collapse into one bucket and the dashboard
 * can't distinguish them.
 *
 * Output: an 8-char hex string usable as a doc id segment.
 */
export function fingerprintError(
  message: string,
  frames: StackFrame[],
  location?: {
    filename?: string | null;
    lineno?: number | null;
    errorType?: string | null;
  } | null,
): string {
  const inAppFrames = frames.filter((f) => f.in_app).slice(0, 3);
  const parts = [
    (message || "").slice(0, 200),
    ...inAppFrames.map((f) => `${f.function}@${f.filename}:${f.lineno}`),
  ];
  if (inAppFrames.length === 0 && location) {
    const loc = [
      location.errorType ?? "",
      location.filename ?? "",
      location.lineno ?? "",
    ].join(":");
    if (loc !== "::") parts.push(loc);
  }
  return djb2Hex(parts.join("|"));
}

/**
 * djb2 — small, fast non-cryptographic string hash. 32-bit output
 * encoded as 8-char hex. Stable across runtimes; deterministic.
 */
function djb2Hex(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  // Force unsigned then 8-char hex.
  return (h >>> 0).toString(16).padStart(8, "0");
}
