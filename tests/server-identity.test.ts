import { describe, it, expect, beforeEach } from "vitest";
import { CrossdeckServer } from "../src/crossdeck-server";
import { stableId } from "../src/_rand";

/**
 * The server's fallback identity must be stable across COLD STARTS.
 *
 * The singleton on globalThis already prevents a second mint inside one
 * process. It cannot help on serverless, where each cold start is a fresh
 * globalThis — which is how one customer's Firebase Functions produced
 * 10,589 distinct identities in 30 days against 679 real visitors, each one
 * creating its own visitor record and counting as a separate person.
 *
 * A new process is simulated here by clearing the singleton map, which is
 * exactly what a cold start does.
 */
function coldStart(): void {
  (globalThis as { __crossdeckServers__?: Map<string, unknown> })
    .__crossdeckServers__?.clear();
}

/** The identity the SDK will attach to server-originated events. */
function identityOf(s: CrossdeckServer): string {
  return (s as unknown as { processAnonymousId: string }).processAnonymousId;
}

const base = {
  secretKey: "cd_sk_test_001",
  appId: "app_web_123",
  sdkVersion: "0.1.0-test",
  errorCapture: false,
  flushOnExit: false,
  bootHeartbeat: false,
} as const;

describe("server identity", () => {
  beforeEach(coldStart);

  it("survives a cold start", () => {
    const first = identityOf(new CrossdeckServer({ ...base }));
    coldStart();
    const second = identityOf(new CrossdeckServer({ ...base }));
    expect(second).toBe(first);
  });

  it("is not random — 25 cold starts yield one identity", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      coldStart();
      seen.add(identityOf(new CrossdeckServer({ ...base })));
    }
    expect(seen.size).toBe(1);
  });

  it("separates services that set serviceName", () => {
    const api = identityOf(new CrossdeckServer({ ...base, serviceName: "api" }));
    coldStart();
    const worker = identityOf(new CrossdeckServer({ ...base, serviceName: "worker" }));
    expect(api).not.toBe(worker);
  });

  it("separates apps", () => {
    const a = identityOf(new CrossdeckServer({ ...base, appId: "app_web_aaa" }));
    coldStart();
    const b = identityOf(new CrossdeckServer({ ...base, appId: "app_web_bbb" }));
    expect(a).not.toBe(b);
  });

  it("ignores serviceVersion, so a deploy does not mint a new identity", () => {
    const v1 = identityOf(new CrossdeckServer({ ...base, serviceVersion: "1.0.0" }));
    coldStart();
    const v2 = identityOf(new CrossdeckServer({ ...base, serviceVersion: "2.0.0" }));
    expect(v2).toBe(v1);
  });

  it("keeps the anon_node_ prefix the backend filters on", () => {
    expect(identityOf(new CrossdeckServer({ ...base }))).toMatch(/^anon_node_/);
  });

  it("stableId is deterministic and input-sensitive", () => {
    expect(stableId("x", ["a", "b"])).toBe(stableId("x", ["a", "b"]));
    expect(stableId("x", ["a", "b"])).not.toBe(stableId("x", ["a", "c"]));
    // joined on NUL, so these must not collide
    expect(stableId("x", ["ab", "c"])).not.toBe(stableId("x", ["a", "bc"]));
  });
});
