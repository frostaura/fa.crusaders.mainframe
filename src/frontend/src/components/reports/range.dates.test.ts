import { describe, expect, it } from "vitest";
import { prettyDay } from "./range";

/**
 * F4-15 (review round 2, MJ) — the wallet's daily activity table read "Sep 30, 2026" in an en-US
 * browser: the reader's locale, where every other date in the product is the club's "Wed 30 Sep".
 */
describe("a report row's day", () => {
  it("is the club's short date with the year, whatever the reader's locale", () => {
    expect(prettyDay("2026-09-30")).toBe("Wed 30 Sep 2026");
    expect(prettyDay("2026-09-01")).toBe("Tue 1 Sep 2026");
  });
});
