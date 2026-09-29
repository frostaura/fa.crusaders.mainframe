import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PENDING_INVITE_TTL_MS, clearPendingInvite, pendingInvite, pendingInvitePath, savePendingInvite,
} from "./playersPending";

/** R1 F2.3 / F2.5 — the invite link a device opened, kept for the journey between. */
afterEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });

describe("the pending invite", () => {
  it("opened signed out, it waits for whoever signs in next — that is the journey", () => {
    savePendingInvite("tok", null, 1_000);
    expect(pendingInvite(null, 2_000)?.token).toBe("tok");
    expect(pendingInvitePath("u-new", 2_000)).toBe("/j/tok");
  });

  it("opened by a member, it is theirs alone — never offered to the next person on this device", () => {
    savePendingInvite("tok", "u-a", 1_000);
    expect(pendingInvite("u-a", 2_000)?.token).toBe("tok");
    expect(pendingInvite("u-b", 2_000)).toBeNull();
    expect(pendingInvite(null, 2_000)).toBeNull();
  });

  it("expires, and forgets itself when it does", () => {
    savePendingInvite("tok", null, 0);
    expect(pendingInvite(null, PENDING_INVITE_TTL_MS + 1)).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it("is cleared by its own token only", () => {
    savePendingInvite("tok", null, 0);
    clearPendingInvite("other");
    expect(pendingInvite(null, 1)?.token).toBe("tok");
    clearPendingInvite("tok");
    expect(pendingInvite(null, 1)).toBeNull();
  });

  it("works without storage — nothing is resurfaced, nothing throws", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => savePendingInvite("tok", null)).not.toThrow();
    expect(pendingInvite(null)).toBeNull();
    expect(() => clearPendingInvite()).not.toThrow();
  });

  it("a token with characters a path must escape is escaped", () => {
    savePendingInvite("a/b", null, 0);
    expect(pendingInvitePath(null, 1)).toBe("/j/a%2Fb");
  });
});
