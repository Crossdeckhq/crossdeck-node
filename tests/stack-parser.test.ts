import { describe, expect, it } from "vitest";

import { parseStack, fingerprintError } from "../src/stack-parser";

describe("parseStack — V8 / Node", () => {
  it("parses Chrome/Node V8 frames with parens: 'at Foo (file:line:col)'", () => {
    const stack = `Error: x\n    at Foo (/app/src/foo.js:42:18)\n    at Bar (/app/src/bar.js:11:5)`;
    const frames = parseStack(stack);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      function: "Foo",
      filename: "/app/src/foo.js",
      lineno: 42,
      colno: 18,
    });
    expect(frames[1]).toMatchObject({
      function: "Bar",
      filename: "/app/src/bar.js",
      lineno: 11,
      colno: 5,
    });
  });

  it("parses anonymous V8 frames without parens: 'at file:line:col'", () => {
    const stack = `Error: x\n    at /app/src/foo.js:42:18`;
    const frames = parseStack(stack);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      function: "?",
      filename: "/app/src/foo.js",
      lineno: 42,
      colno: 18,
    });
  });

  it("parses Firefox/Safari frames: 'Foo@file:line:col'", () => {
    const stack = `Foo@/app/src/foo.js:42:18`;
    const frames = parseStack(stack);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      function: "Foo",
      filename: "/app/src/foo.js",
      lineno: 42,
      colno: 18,
    });
  });

  it("skips the header line (TypeError: x is not a function)", () => {
    const stack = `TypeError: x is not a function\n    at Foo (/app/foo.js:1:1)`;
    const frames = parseStack(stack);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.function).toBe("Foo");
  });

  it("falls back to a raw frame for unparseable but plausible lines", () => {
    const stack = `at Foo some garbage with: colon`;
    const frames = parseStack(stack);
    expect(frames[0]?.raw).toBe("at Foo some garbage with: colon");
    expect(frames[0]?.lineno).toBe(0);
    expect(frames[0]?.filename).toBe("");
  });

  it("returns [] for null / undefined / empty input", () => {
    expect(parseStack(null)).toEqual([]);
    expect(parseStack(undefined)).toEqual([]);
    expect(parseStack("")).toEqual([]);
  });
});

describe("isInAppFrame — Node heuristics (via parseStack.in_app)", () => {
  it("false for filenames containing /node_modules/", () => {
    const frames = parseStack(`Error\n    at Foo (/app/node_modules/express/lib/router.js:1:1)`);
    expect(frames[0]?.in_app).toBe(false);
  });

  it("false for node: URLs (Node 16+ core modules)", () => {
    const frames = parseStack(`Error\n    at Foo (node:fs:123:45)`);
    expect(frames[0]?.in_app).toBe(false);
  });

  it("false for filenames starting with internal/ (Node core internals)", () => {
    const frames = parseStack(`Error\n    at Foo (internal/process/task_queues.js:96:5)`);
    expect(frames[0]?.in_app).toBe(false);
  });

  it("false for @cross-deck/node frames (SDK self-skip)", () => {
    const frames = parseStack(
      `Error\n    at Foo (/app/node_modules/@cross-deck/node/dist/index.cjs:99:1)`,
    );
    expect(frames[0]?.in_app).toBe(false);
  });

  it("true for app frames in the caller's own codebase", () => {
    const frames = parseStack(`Error\n    at Foo (/app/src/main.js:1:1)`);
    expect(frames[0]?.in_app).toBe(true);
  });
});

describe("fingerprintError", () => {
  it("returns an 8-char lowercase hex string", () => {
    expect(fingerprintError("boom", [])).toMatch(/^[0-9a-f]{8}$/);
  });

  it("same input produces same fingerprint (deterministic across processes)", () => {
    expect(fingerprintError("boom", [])).toBe(fingerprintError("boom", []));
  });

  it("different messages produce different fingerprints", () => {
    expect(fingerprintError("boom", [])).not.toBe(fingerprintError("crash", []));
  });

  it("only the first 3 in-app frames affect the fingerprint", () => {
    const base = parseStack(
      `Error\n    at F1 (/app/a.js:1:1)\n    at F2 (/app/b.js:2:2)\n    at F3 (/app/c.js:3:3)`,
    );
    const extended = parseStack(
      `Error\n    at F1 (/app/a.js:1:1)\n    at F2 (/app/b.js:2:2)\n    at F3 (/app/c.js:3:3)\n    at F4 (/app/d.js:4:4)`,
    );
    expect(fingerprintError("boom", base)).toBe(fingerprintError("boom", extended));
  });
});
