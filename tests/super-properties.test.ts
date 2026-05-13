import { describe, expect, it } from "vitest";

import { SuperPropertyStore } from "../src/super-properties";

describe("SuperPropertyStore — register / unregister", () => {
  it("register({ plan: 'pro' }) adds the key to the bag", () => {
    const s = new SuperPropertyStore();
    s.register({ plan: "pro" });
    expect(s.getSuperProperties()).toEqual({ plan: "pro" });
  });

  it("register({ plan: null }) deletes the key (Mixpanel idiom)", () => {
    const s = new SuperPropertyStore();
    s.register({ plan: "pro" });
    s.register({ plan: null });
    expect(s.getSuperProperties()).toEqual({});
  });

  it("register({ x: undefined }) is a no-op (does not add an undefined entry)", () => {
    const s = new SuperPropertyStore();
    s.register({ a: "1", x: undefined });
    expect(s.getSuperProperties()).toEqual({ a: "1" });
  });

  it("subsequent register() calls merge additively", () => {
    const s = new SuperPropertyStore();
    s.register({ name: "Wes" });
    s.register({ plan: "pro" });
    expect(s.getSuperProperties()).toEqual({ name: "Wes", plan: "pro" });
  });

  it("unregister(key) removes a single key", () => {
    const s = new SuperPropertyStore();
    s.register({ a: 1, b: 2 });
    s.unregister("a");
    expect(s.getSuperProperties()).toEqual({ b: 2 });
  });

  it("unregister(unknownKey) is a no-op (idempotent)", () => {
    const s = new SuperPropertyStore();
    s.register({ a: 1 });
    expect(() => s.unregister("z")).not.toThrow();
    expect(s.getSuperProperties()).toEqual({ a: 1 });
  });

  it("getSuperProperties() returns a defensive copy", () => {
    const s = new SuperPropertyStore();
    s.register({ a: 1 });
    const snap = s.getSuperProperties();
    snap.b = 99;
    expect(s.getSuperProperties()).toEqual({ a: 1 });
  });
});

describe("SuperPropertyStore — groups", () => {
  it("setGroup('org', 'acme') records the membership", () => {
    const s = new SuperPropertyStore();
    s.setGroup("org", "acme");
    expect(s.getGroups()).toEqual({ org: { id: "acme" } });
  });

  it("setGroup('org', null) clears the membership for that type", () => {
    const s = new SuperPropertyStore();
    s.setGroup("org", "acme");
    s.setGroup("org", null);
    expect(s.getGroups()).toEqual({});
  });

  it("multiple group types coexist (org + team + plan)", () => {
    const s = new SuperPropertyStore();
    s.setGroup("org", "acme");
    s.setGroup("team", "design", { headcount: 12 });
    s.setGroup("plan", "enterprise");
    expect(Object.keys(s.getGroups()).sort()).toEqual(["org", "plan", "team"]);
  });

  it("getGroups() returns a deep copy with optional traits", () => {
    const s = new SuperPropertyStore();
    s.setGroup("team", "design", { headcount: 12 });
    const snap = s.getGroups();
    snap.team!.traits!.headcount = 999;
    expect(s.getGroups().team!.traits).toEqual({ headcount: 12 });
  });

  it("getGroupIds() returns a flat { type: id } map for event attachment", () => {
    const s = new SuperPropertyStore();
    s.setGroup("org", "acme");
    s.setGroup("team", "design", { headcount: 12 });
    expect(s.getGroupIds()).toEqual({ org: "acme", team: "design" });
  });
});

describe("SuperPropertyStore — clear / persistence", () => {
  it("clear() wipes both super-props and groups", () => {
    const s = new SuperPropertyStore();
    s.register({ plan: "pro" });
    s.setGroup("org", "acme");
    s.clear();
    expect(s.getSuperProperties()).toEqual({});
    expect(s.getGroups()).toEqual({});
  });

  it("in-memory only — instantiating a fresh store does NOT see prior data (no localStorage)", () => {
    const s1 = new SuperPropertyStore();
    s1.register({ plan: "pro" });
    const s2 = new SuperPropertyStore();
    expect(s2.getSuperProperties()).toEqual({});
  });
});
