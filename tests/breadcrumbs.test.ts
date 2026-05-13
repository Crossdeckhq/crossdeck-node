import { describe, expect, it } from "vitest";

import { BreadcrumbBuffer } from "../src/breadcrumbs";

describe("BreadcrumbBuffer", () => {
  it("add() appends a crumb to the buffer", () => {
    const b = new BreadcrumbBuffer();
    b.add({ timestamp: 1, category: "custom", message: "a" });
    b.add({ timestamp: 2, category: "custom", message: "b" });
    expect(b.size).toBe(2);
    expect(b.snapshot().map((c) => c.message)).toEqual(["a", "b"]);
  });

  it("snapshot() returns a defensive copy — mutating it does not affect the buffer", () => {
    const b = new BreadcrumbBuffer();
    b.add({ timestamp: 1, category: "custom", message: "a" });
    const snap = b.snapshot();
    snap.push({ timestamp: 99, category: "custom", message: "extra" });
    expect(b.size).toBe(1);
    expect(b.snapshot()).toHaveLength(1);
  });

  it("buffer at maxSize evicts the oldest on next add", () => {
    const b = new BreadcrumbBuffer(3);
    b.add({ timestamp: 1, category: "custom", message: "a" });
    b.add({ timestamp: 2, category: "custom", message: "b" });
    b.add({ timestamp: 3, category: "custom", message: "c" });
    b.add({ timestamp: 4, category: "custom", message: "d" });
    expect(b.snapshot().map((c) => c.message)).toEqual(["b", "c", "d"]);
    expect(b.size).toBe(3);
  });

  it("clear() wipes the buffer and resets size to 0", () => {
    const b = new BreadcrumbBuffer();
    b.add({ timestamp: 1, category: "custom", message: "a" });
    b.add({ timestamp: 2, category: "custom", message: "b" });
    b.clear();
    expect(b.size).toBe(0);
    expect(b.snapshot()).toEqual([]);
  });

  it("size getter reflects current item count", () => {
    const b = new BreadcrumbBuffer();
    expect(b.size).toBe(0);
    b.add({ timestamp: 1, category: "custom" });
    expect(b.size).toBe(1);
    b.add({ timestamp: 2, category: "custom" });
    expect(b.size).toBe(2);
  });
});
