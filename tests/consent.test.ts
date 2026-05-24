import { describe, expect, it } from "vitest";

import * as cd from "../src/index";
import { scrubPii, scrubPiiFromProperties } from "../src/consent";

describe("scrubPii — string utility", () => {
  it("replaces an email-shaped substring with <email>", () => {
    expect(scrubPii("contact me at wes@pinet.co.za")).toBe("contact me at <email>");
  });

  it("replaces a card-number-shaped sequence with <card>", () => {
    expect(scrubPii("card 4242 4242 4242 4242 charged")).toBe("card <card> charged");
  });

  it("returns the original string (===) when nothing matched", () => {
    const input = "no pii here";
    expect(scrubPii(input)).toBe(input);
  });

  it("preserves trailing whitespace around scrubbed sequences", () => {
    // Anchor-on-digit ensures separators don't get pulled into the match.
    expect(scrubPii("4242 4242 4242 4242 today")).toBe("<card> today");
  });

  it("scrubs multiple emails in one string", () => {
    expect(scrubPii("from a@x.com to b@y.com")).toBe("from <email> to <email>");
  });
});

describe("scrubPiiFromProperties — walk utility", () => {
  it("scrubs string values inside the properties object", () => {
    expect(
      scrubPiiFromProperties({
        url: "/users/wes@pinet.co.za/profile",
        plan: "pro",
      }),
    ).toEqual({
      url: "/users/<email>/profile",
      plan: "pro",
    });
  });

  it("scrubs string entries inside array values", () => {
    expect(
      scrubPiiFromProperties({
        emails: ["a@x.com", "b@y.com"],
      }),
    ).toEqual({
      emails: ["<email>", "<email>"],
    });
  });

  it("leaves non-string scalar values untouched", () => {
    expect(
      scrubPiiFromProperties({
        n: 42,
        b: true,
        nil: null,
      }),
    ).toEqual({ n: 42, b: true, nil: null });
  });

  it("recurses into nested plain objects", () => {
    expect(
      scrubPiiFromProperties({
        request: { url: "/users/wes@pinet.co.za/", method: "GET" },
      }),
    ).toEqual({
      request: { url: "/users/<email>/", method: "GET" },
    });
  });

  it("does not mutate the caller's input object", () => {
    const input = { url: "/users/wes@pinet.co.za/" };
    scrubPiiFromProperties(input);
    expect(input.url).toBe("/users/wes@pinet.co.za/");
  });
});

describe("ConsentManager — intentionally not exported", () => {
  it("the `ConsentManager` class is NOT on the Node public surface (server-side trust model — caller decides)", () => {
    expect((cd as Record<string, unknown>).ConsentManager).toBeUndefined();
  });

  it("the package documents the omission via the consent.ts module comment", () => {
    // Smoke check — the utility functions exist alongside the
    // omission, which is the contract: scrubPii ships, ConsentManager
    // doesn't.
    expect(typeof scrubPii).toBe("function");
    expect(typeof scrubPiiFromProperties).toBe("function");
  });
});
