import { describe, it, expect } from "vitest";
import { ApiError, NetworkError } from "./api";
import { describeFailure, isDeploymentFault } from "./errors";

/**
 * The invariant these exist to hold: ONLY a NetworkError may be described to a member as a
 * connection problem. Every screen in this app used to end its error handling with a variant
 * of "Check your connection and try again", and for most of what reached that line the
 * diagnosis was false — most damagingly on register, where a production database with no
 * tenant row told five people in a row that their internet was broken.
 */

const api = (status: number, body?: unknown) => new ApiError(status, body);

describe("describeFailure", () => {
  describe("never blames the connection for something that is not the connection", () => {
    const notNetwork: [string, unknown][] = [
      ["a missing tenant row", api(404, { error: "tenant_not_found" })],
      ["an unresolved tenant", api(400, { error: "tenant_unresolved" })],
      ["a server crash", api(500, { error: "boom" })],
      ["a bad gateway", api(502)],
      ["a rate limit", api(429)],
      ["an unrecognised refusal", api(418, { error: "teapot" })],
      ["a refusal with no code at all", api(400)],
      ["something that is not our error type", new TypeError("cannot read property of undefined")],
    ];

    it.each(notNetwork)("%s", (_label, err) => {
      const message = describeFailure(err, { action: "do the thing" });
      expect(message).not.toMatch(/connection/i);
      expect(message).not.toMatch(/internet/i);
      expect(message).not.toMatch(/offline/i);
    });
  });

  describe("does say so when the connection genuinely failed", () => {
    it("names it as unreachable", () => {
      expect(describeFailure(new NetworkError("unreachable"))).toMatch(/connection/i);
    });

    it("distinguishes a timeout from an unreachable host", () => {
      const timeout = describeFailure(new NetworkError("timeout"));
      const unreachable = describeFailure(new NetworkError("unreachable"));
      expect(timeout).toMatch(/too long/i);
      expect(timeout).not.toBe(unreachable);
    });
  });

  describe("resolution order", () => {
    it("prefers the screen's own sentence over the shared one", () => {
      const message = describeFailure(api(404, { error: "tenant_not_found" }), {
        codes: { tenant_not_found: "SCREEN SPECIFIC" },
      });
      expect(message).toBe("SCREEN SPECIFIC");
    });

    it("falls back to the shared sentence for a code the screen does not know", () => {
      expect(describeFailure(api(404, { error: "tenant_not_found" }), { codes: { other: "x" } }))
        .toMatch(/isn't set up on Mainframe/i);
    });

    /**
     * Middleware refusals arrive on requests to endpoints that know nothing about them, so a
     * screen mapping only its own endpoint's codes shows its generic fallback for a deployment
     * fault — which is how the outage read as a mystery for as long as it did.
     */
    it("recognises a cross-cutting code even when the screen supplied a fallback", () => {
      const message = describeFailure(api(404, { error: "tenant_not_found" }), { fallback: "GENERIC" });
      expect(message).not.toBe("GENERIC");
    });

    it("uses the status sentence only when no code matched", () => {
      expect(describeFailure(api(500, { error: "known" }), { codes: { known: "MAPPED" } })).toBe("MAPPED");
    });

    it("uses the screen's fallback for a refusal nothing else recognised", () => {
      expect(describeFailure(api(400, { error: "weird" }), { fallback: "FALLBACK" })).toBe("FALLBACK");
    });
  });

  describe("the action clause", () => {
    it("says what failed as well as why", () => {
      const message = describeFailure(api(500), { action: "get a code" });
      expect(message).toMatch(/Couldn't get a code/);
      expect(message).toMatch(/club's system/i);
    });

    it("applies to connection failures too, not only server ones", () => {
      expect(describeFailure(new NetworkError("unreachable"), { action: "load the schedule" }))
        .toMatch(/Couldn't load the schedule/);
    });

    it("still produces a readable sentence with no action given", () => {
      const message = describeFailure(api(500));
      expect(message[0]).toBe(message[0].toUpperCase());
      expect(message).not.toMatch(/^Couldn't —/);
    });

    /** Rate limiting is about the rate of attempts, not about the thing attempted. */
    it("leaves the rate-limit sentence alone", () => {
      expect(describeFailure(api(429), { action: "get a code" })).toMatch(/^Too many requests right now/);
    });
  });

  describe("the sentences themselves", () => {
    it("tells a member that a missing tenant is not theirs to fix, and who is", () => {
      const message = describeFailure(api(404, { error: "tenant_not_found" }));
      expect(message).toMatch(/committee/i);
      expect(message).not.toMatch(/try again/i);
    });

    it("does not tell a member to retry something retrying cannot fix", () => {
      expect(describeFailure(api(404, { error: "tenant_not_found" }))).not.toMatch(/try again/i);
    });

    it("says an expired session is an expired session", () => {
      expect(describeFailure(api(401, { error: "invalid_token" }))).toMatch(/session has expired/i);
    });
  });
});

describe("isDeploymentFault", () => {
  it.each([
    ["a missing tenant", api(404, { error: "tenant_not_found" }), true],
    ["an unresolved tenant", api(400, { error: "tenant_unresolved" }), true],
    ["a server crash", api(500), true],
    ["a bad gateway", api(502), true],
    ["a wrong password", api(401), false],
    ["a rate limit", api(429), false],
    ["a validation refusal", api(400, { error: "missing_fields" }), false],
    // A dropped connection is the member's problem to retry, not the operator's to fix — so
    // the retry affordance must stay on screen for it.
    ["a dropped connection", new NetworkError("unreachable"), false],
  ])("%s", (_label, err, expected) => {
    expect(isDeploymentFault(err)).toBe(expected);
  });
});
