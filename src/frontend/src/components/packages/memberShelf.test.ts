import { describe, expect, it } from "vitest";
import { adminPackage } from "@/test/adminResponseFixtures";
import { memberShelfOf, memberShelfWith } from "./memberShelf";

/** J6-5 — the shelf a saving is measured against is the member's (§4.2 ∪, §4.3 baseline). */
describe("memberShelfOf", () => {
  const club = adminPackage({ id: "c1", name: "1 hour", minutes: 60, price_zar: 99.99 });
  const mine = adminPackage({ id: "g1", name: "League night", minutes: 90, price_zar: 150, group: { id: "g-a", name: "A" } });
  const theirs = adminPackage({ id: "g2", name: "Other night", minutes: 30, price_zar: 10, group: { id: "g-b", name: "B" } });
  const retired = adminPackage({ id: "c0", name: "Old", minutes: 15, price_zar: 5, status: "archived" });
  const all = [club, mine, theirs, retired];
  const groups = [{ id: "g-a", name: "A", package_discount_bps: 1500 }, { id: "g-b", name: "B", package_discount_bps: null }];

  it("is the club's on-sale packages for the club's shelf", () => {
    expect(memberShelfOf(all, null, groups).map((p) => p.id)).toEqual(["c1"]);
  });

  it("adds the club's packages at the group's discount, floored to the cent, and never another group's", () => {
    const shelf = memberShelfOf(all, "g-a", groups);
    expect(shelf.map((p) => p.id)).toEqual(["c1", "g1"]);
    // 9 999 c × 8 500 ÷ 10 000 = 8 499.15 c → R84.99, down.
    expect(shelf[0].price_zar).toBe(84.99);
    expect(shelf[1].price_zar).toBe(150);
  });

  it("takes no discount when the group sets none, or the groups could not be read", () => {
    expect(memberShelfOf(all, "g-b", groups)[0].price_zar).toBe(99.99);
    expect(memberShelfOf(all, "g-a", null)[0].price_zar).toBe(99.99);
  });

  it("puts the draft in place of the package it edits", () => {
    const draft = { id: "g1", name: "League night", minutes: 120, price_zar: 140 };
    expect(memberShelfWith(all, "g-a", groups, draft)).toEqual([expect.objectContaining({ id: "c1" }), draft]);
  });
});
