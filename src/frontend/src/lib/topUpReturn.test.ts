import { afterEach, describe, expect, it } from "vitest";
import { rememberTopUpReturn, returnLabel, safeReturnTo, TOPUP_RETURN_COPY, topUpReturnFor } from "./topUpReturn";

afterEach(() => sessionStorage.clear());

describe("the way back from a top-up", () => {
  it.each([
    ["/j/abc", "/j/abc"],
    ["/invites/p-1?x=1", "/invites/p-1?x=1"],
    ["https://evil.example/j/abc", null],
    ["//evil.example", null],
    ["/\\evil.example", null],
    ["javascript:alert(1)", null],
    ["", null],
  ])("accepts only an in-app path: %s", (value, expected) => {
    expect(safeReturnTo(value)).toBe(expected);
  });

  it("survives the PayFast round-trip under the top-up's id, and nothing else's", () => {
    rememberTopUpReturn("t-1", "/j/abc");
    rememberTopUpReturn("t-2", "https://evil.example");
    expect(topUpReturnFor("t-1")).toBe("/j/abc");
    expect(topUpReturnFor("t-2")).toBeNull();
    expect(topUpReturnFor("t-3")).toBeNull();
  });

  it("calls an invite an invite", () => {
    expect(returnLabel("/j/abc")).toBe(TOPUP_RETURN_COPY.invite);
    expect(returnLabel("/invites/p-1")).toBe(TOPUP_RETURN_COPY.invite);
    expect(returnLabel("/bookings")).toBe(TOPUP_RETURN_COPY.elsewhere);
  });
});
