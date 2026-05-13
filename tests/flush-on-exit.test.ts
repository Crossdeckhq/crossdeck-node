import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FlushOnExit } from "../src/flush-on-exit";

describe("FlushOnExit — installation", () => {
  it("install() registers handlers for 'beforeExit', 'SIGTERM', and 'SIGINT'", () => {
    const before = {
      beforeExit: process.listenerCount("beforeExit"),
      SIGTERM: process.listenerCount("SIGTERM"),
      SIGINT: process.listenerCount("SIGINT"),
    };

    const f = new FlushOnExit({ drain: async () => undefined });
    try {
      f.install();
      expect(process.listenerCount("beforeExit")).toBe(before.beforeExit + 1);
      expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM + 1);
      expect(process.listenerCount("SIGINT")).toBe(before.SIGINT + 1);
    } finally {
      f.uninstall();
    }

    expect(process.listenerCount("beforeExit")).toBe(before.beforeExit);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
  });

  it("install() is idempotent — second call does not add duplicate handlers", () => {
    const before = process.listenerCount("beforeExit");
    const f = new FlushOnExit({ drain: async () => undefined });
    try {
      f.install();
      f.install();
      f.install();
      expect(process.listenerCount("beforeExit")).toBe(before + 1);
    } finally {
      f.uninstall();
    }
  });

  it("uninstall() is idempotent — second call is a no-op", () => {
    const f = new FlushOnExit({ drain: async () => undefined });
    f.install();
    f.uninstall();
    expect(() => f.uninstall()).not.toThrow();
  });
});

describe("FlushOnExit — drain behaviour", () => {
  it("drainNow() runs the drain function and fires onStart + onComplete", async () => {
    const drain = vi.fn().mockResolvedValue(undefined);
    const onStart = vi.fn();
    const onComplete = vi.fn();
    const f = new FlushOnExit({ drain, onStart, onComplete });
    try {
      await f.drainNow();
      expect(drain).toHaveBeenCalledTimes(1);
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete.mock.calls[0]![0]).toMatchObject({ timedOut: false });
    } finally {
      f.uninstall();
    }
  });

  it("drainNow() is one-shot — subsequent calls do not re-invoke drain", async () => {
    const drain = vi.fn().mockResolvedValue(undefined);
    const f = new FlushOnExit({ drain });
    try {
      await f.drainNow();
      await f.drainNow();
      await f.drainNow();
      expect(drain).toHaveBeenCalledTimes(1);
    } finally {
      f.uninstall();
    }
  });

  it("drain bounded by timeoutMs — onComplete fires with timedOut: true past the cap", async () => {
    let neverResolve!: () => void;
    const drain = (): Promise<unknown> =>
      new Promise((resolve) => {
        neverResolve = () => resolve(undefined);
      });
    const onComplete = vi.fn();
    const f = new FlushOnExit({ drain, timeoutMs: 50, onComplete });
    try {
      await f.drainNow();
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete.mock.calls[0]![0]).toMatchObject({ timedOut: true });
    } finally {
      neverResolve(); // unblock the hanging promise
      f.uninstall();
    }
  });

  it("drain that throws does not prevent drainNow() from completing", async () => {
    const drain = vi.fn().mockRejectedValue(new Error("drain crashed"));
    const onError = vi.fn();
    const onComplete = vi.fn();
    const f = new FlushOnExit({ drain, onError, onComplete });
    try {
      await expect(f.drainNow()).resolves.toBeUndefined();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledTimes(1);
    } finally {
      f.uninstall();
    }
  });

  it("hasDrained flips to true after the first drain completes", async () => {
    const f = new FlushOnExit({ drain: async () => undefined });
    try {
      expect(f.hasDrained).toBe(false);
      await f.drainNow();
      expect(f.hasDrained).toBe(true);
    } finally {
      f.uninstall();
    }
  });

  it("isDraining is true while the drain is in flight, false after completion", async () => {
    let resolveDrain!: () => void;
    const drain = (): Promise<unknown> =>
      new Promise((resolve) => {
        resolveDrain = () => resolve(undefined);
      });
    const f = new FlushOnExit({ drain });
    try {
      expect(f.isDraining).toBe(false);
      const p = f.drainNow();
      expect(f.isDraining).toBe(true);
      resolveDrain();
      await p;
      expect(f.isDraining).toBe(false);
    } finally {
      f.uninstall();
    }
  });
});

describe("FlushOnExit — disable / lifecycle", () => {
  it("uninstall() removes the beforeExit handler immediately", () => {
    const before = process.listenerCount("beforeExit");
    const f = new FlushOnExit({ drain: async () => undefined });
    f.install();
    expect(process.listenerCount("beforeExit")).toBe(before + 1);
    f.uninstall();
    expect(process.listenerCount("beforeExit")).toBe(before);
  });

  it("does not install handlers when install() is not called", () => {
    const before = {
      beforeExit: process.listenerCount("beforeExit"),
      SIGTERM: process.listenerCount("SIGTERM"),
    };
    new FlushOnExit({ drain: async () => undefined });
    expect(process.listenerCount("beforeExit")).toBe(before.beforeExit);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
  });
});
