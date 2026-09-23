import { describe, expect, it } from "vitest";
import { memberFixture } from "../../test/harness";
import { initialsOf, listSends, nextSort, patchRow, statusCounts, visibleRows, type MemberRow } from "./membersModel";
import { lastSeen, statusFilterFrom } from "../../lib/membersCopy";

const row = (o: Record<string, unknown>) => memberFixture(o) as MemberRow;

const CLUB: MemberRow[] = [
  row({ user_id: "a", full_name: "Zola Budd", status: "Active", balance_credits: 10, created_at: "2026-01-01T00:00:00Z" }),
  row({ user_id: "b", full_name: "ada lovelace", status: "PendingApproval", balance_credits: -5, created_at: "2026-03-01T00:00:00Z" }),
  row({ user_id: "c", full_name: "Brian Habana", status: "Suspended", balance_credits: 200, email: "wing@club.test", created_at: "2026-02-01T00:00:00Z" }),
];

describe("the members list's rules", () => {
  it("counts every status, and says nothing at all before the list is read", () => {
    expect(statusCounts(null)).toBeNull();
    expect(statusCounts(CLUB)).toEqual({ all: 3, PendingApproval: 1, Active: 1, Suspended: 1, Rejected: 0 });
  });

  it("filters by status and by name, email or number, case-insensitively", () => {
    const sort = { key: "full_name", dir: "asc" } as const;
    expect(visibleRows(CLUB, "Suspended", "", sort).map((r) => r.user_id)).toEqual(["c"]);
    expect(visibleRows(CLUB, "all", "WING@", sort).map((r) => r.user_id)).toEqual(["c"]);
    expect(visibleRows(CLUB, "all", "", sort).map((r) => r.full_name)).toEqual(["ada lovelace", "Brian Habana", "Zola Budd"]);
  });

  it("sorts newest, richest and most recent first when a column is first chosen", () => {
    expect(nextSort({ key: "full_name", dir: "asc" }, "balance_credits")).toEqual({ key: "balance_credits", dir: "desc" });
    expect(nextSort({ key: "balance_credits", dir: "desc" }, "balance_credits")).toEqual({ key: "balance_credits", dir: "asc" });
    expect(visibleRows(CLUB, "all", "", { key: "balance_credits", dir: "desc" }).map((r) => r.user_id)).toEqual(["c", "a", "b"]);
    expect(visibleRows(CLUB, "all", "", { key: "created_at", dir: "desc" }).map((r) => r.user_id)).toEqual(["b", "c", "a"]);
  });

  it("does not mutate the list it was given", () => {
    const before = CLUB.map((r) => r.user_id);
    visibleRows(CLUB, "all", "", { key: "balance_credits", dir: "asc" });
    expect(CLUB.map((r) => r.user_id)).toEqual(before);
  });

  it("patches one row in place", () => {
    const next = patchRow(CLUB, "b", { balance_credits: 40 })!;
    expect(next[1].balance_credits).toBe(40);
    expect(next[0]).toBe(CLUB[0]);
    expect(patchRow(null, "b", {})).toBeNull();
  });

  it("draws a column only when the list sends its field", () => {
    expect(listSends(CLUB, "last_login_at")).toBe(false);
    expect(listSends([...CLUB, row({ last_login_at: null })], "last_login_at")).toBe(true);
    expect(listSends(null, "groups")).toBe(false);
  });

  it("reads anything that is not a status in the URL as every status", () => {
    expect(statusFilterFrom("PendingApproval")).toBe("PendingApproval");
    expect(statusFilterFrom("pending")).toBe("all");
    expect(statusFilterFrom(null)).toBe("all");
  });

  it("names last-seen recency in words for a week, then as a date", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(lastSeen(null, now)).toBe("Never");
    expect(lastSeen("2026-09-23T08:00:00Z", now)).toBe("Today");
    expect(lastSeen("2026-09-22T08:00:00Z", now)).toBe("Yesterday");
    expect(lastSeen("2026-09-19T08:00:00Z", now)).toBe("4 days ago");
    expect(lastSeen("2026-08-01T08:00:00Z", now)).toMatch(/Aug 2026/);
  });

  it("draws initials from the first and last word", () => {
    expect(initialsOf("Ada King Lovelace")).toBe("AL");
    expect(initialsOf("cher")).toBe("C");
    expect(initialsOf("  ")).toBe("?");
  });
});
