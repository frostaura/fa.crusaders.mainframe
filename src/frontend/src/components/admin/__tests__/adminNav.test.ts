import { describe, expect, it } from "vitest";
import {
  ADMIN_NAV, ADMIN_NAV_ITEMS, activeAdminItem, adminGroupOf, isAdminItemActive,
} from "../adminNav";
import {
  adminAttentionLabel, attentionBadge, doorsAttentionLabel, faultsAttentionLabel, monitoringAttentionLabel,
  openFaultCount, pendingApplicationsLabel,
} from "@/lib/adminAttention";

/**
 * The admin IA is ONE list, and exactly one item in it is ever "you are here".
 *
 * The rail, the phone's section sheet, the section bar and the Overview's quick links all render
 * from `ADMIN_NAV`; what is pinned here is the matching rule they share, because a rule each of
 * them re-derived is how Control board and Doors both light up on a door's page.
 */
describe("the admin IA", () => {
  it("is grouped the way the plan's Target IA reads", () => {
    expect(ADMIN_NAV.map((g) => g.label)).toEqual(["Overview", "People", "Money", "Courts & hardware", "Setup"]);
    expect(ADMIN_NAV_ITEMS.map((i) => i.label)).toEqual([
      "Overview",
      "Members", "Groups",
      "Transactions", "Reports",
      "Control board", "Doors", "Boards", "Faults", "Change record", "Repeating bookings", "Courts",
      "Settings", "Webhooks",
    ]);
  });

  it("gives every destination a unique path, a unique id, an icon and a one-line description", () => {
    expect(new Set(ADMIN_NAV_ITEMS.map((i) => i.path)).size).toBe(ADMIN_NAV_ITEMS.length);
    expect(new Set(ADMIN_NAV_ITEMS.map((i) => i.id)).size).toBe(ADMIN_NAV_ITEMS.length);
    for (const item of ADMIN_NAV_ITEMS) {
      expect(item.path.startsWith("/admin"), item.id).toBe(true);
      expect(item.icon, item.id).toBeTruthy();
      expect(item.description.length, item.id).toBeGreaterThan(10);
      expect(item.description, item.id).not.toContain("\n");
    }
  });

  it("puts the three badges on Members, Doors and Faults and nowhere else", () => {
    const badged = ADMIN_NAV_ITEMS.filter((i) => i.badge).map((i) => [i.id, i.badge]);
    expect(badged).toEqual([["members", "pending"], ["doors", "doors"], ["faults", "faults"]]);
  });

  it.each([
    ["/admin", "overview"],
    ["/admin/", "overview"],
    ["/admin/members", "members"],
    ["/admin/members/", "members"],
    ["/admin/members/7f1c/wallet", "members"],
    // P5 — a member's own page and its night tab are Members, never Control board.
    ["/admin/members/7f1c", "members"],
    ["/admin/members/7f1c/night", "members"],
    ["/admin/courts", "courts"],
    ["/admin/groups", "groups"],
    ["/admin/transactions", "transactions"],
    ["/admin/reports", "reports"],
    ["/admin/monitoring", "control-board"],
    ["/admin/monitoring/doors", "doors"],
    ["/admin/monitoring/doors/log", "doors"],
    ["/admin/monitoring/doors/99999999-9999-9999-9999-999999999999", "doors"],
    ["/admin/monitoring/doors/99999999-9999-9999-9999-999999999999/card", "doors"],
    ["/admin/monitoring/devices", "boards"],
    ["/admin/monitoring/faults", "faults"],
    ["/admin/monitoring/changes", "changes"],
    ["/admin/schedules", "schedules"],
    ["/admin/schedules/5", "schedules"],
    ["/admin/settings", "settings"],
    ["/admin/webhooks", "webhooks"],
  ])("%s is the %s item", (path, id) => {
    expect(activeAdminItem(path)?.id).toBe(id);
  });

  it("never lights Doors on the control board — nor the control board on a door", () => {
    const doors = ADMIN_NAV_ITEMS.find((i) => i.id === "doors")!;
    const board = ADMIN_NAV_ITEMS.find((i) => i.id === "control-board")!;
    expect(isAdminItemActive(doors, "/admin/monitoring")).toBe(false);
    expect(isAdminItemActive(board, "/admin/monitoring")).toBe(true);
    expect(isAdminItemActive(board, "/admin/monitoring/doors/abc")).toBe(false);
    expect(isAdminItemActive(doors, "/admin/monitoring/doors/abc")).toBe(true);
  });

  it("matches on a segment boundary, so /admin/groupsx is not Groups", () => {
    expect(activeAdminItem("/admin/groupsx")?.id).toBe("overview");
    expect(activeAdminItem("/admin/monitoringx")?.id).toBe("overview");
  });

  it("is nothing outside the console", () => {
    expect(activeAdminItem("/bookings")).toBeNull();
    expect(activeAdminItem("/administrator")).toBeNull();
    expect(activeAdminItem("/")).toBeNull();
  });

  it("lights exactly one item for every destination and every nested page", () => {
    const paths = ADMIN_NAV_ITEMS.flatMap((i) => [i.path, `${i.path}/nested/page`]);
    for (const path of paths) {
      const lit = ADMIN_NAV_ITEMS.filter((item) => isAdminItemActive(item, path));
      expect(lit.length, path).toBe(1);
    }
  });

  it("knows each item's group", () => {
    const doors = ADMIN_NAV_ITEMS.find((i) => i.id === "doors")!;
    expect(adminGroupOf(doors)?.label).toBe("Courts & hardware");
  });
});

describe("the attention wording", () => {
  it("keeps Layout's application sentence verbatim", () => {
    expect(pendingApplicationsLabel(1)).toBe("1 membership application awaiting review");
    expect(pendingApplicationsLabel(3)).toBe("3 membership applications awaiting review");
  });

  it("counts doors and faults in their own words", () => {
    expect(doorsAttentionLabel(1)).toBe("1 door needs attention");
    expect(doorsAttentionLabel(2)).toBe("2 doors need attention");
    // Faults, not boards: the count is of fault rows, and one board can hold three.
    expect(faultsAttentionLabel(1)).toBe("1 fault needs attention");
    expect(faultsAttentionLabel(4)).toBe("4 faults need attention");
  });

  it("says both monitoring halves, one half, or nothing — Layout's signature kept", () => {
    expect(monitoringAttentionLabel(2, 1)).toBe("2 doors need attention and 1 fault needs attention");
    expect(monitoringAttentionLabel(1)).toBe("1 door needs attention");
    expect(monitoringAttentionLabel(0, 3)).toBe("3 faults need attention");
    expect(monitoringAttentionLabel(0, 0)).toBe("");
  });

  it("joins all three for the Admin tab, and says nothing at zero", () => {
    expect(adminAttentionLabel({ pending: 1, doors: 2, faults: 3 }))
      .toBe("1 membership application awaiting review, 2 doors need attention and 3 faults need attention");
    expect(adminAttentionLabel({ pending: 0, doors: 0, faults: 0 })).toBe("");
  });

  it("does not count a board's boot as a fault that needs somebody", () => {
    // Every board boots, and every boot is recorded at info (DeviceErrorCodes.Boot). A badge that
    // fired on each restart would be a badge an admin learns to ignore (A2.6).
    expect(openFaultCount({ critical: 1, error: 2, warning: 3, info: 40 })).toBe(6);
    expect(openFaultCount({ info: 9 })).toBe(0);
    expect(openFaultCount(undefined)).toBe(0);
  });

  it("pairs each badge key with its count and sentence", () => {
    const counts = { pending: 2, doors: 1, faults: 5 };
    expect(attentionBadge("pending", counts)).toEqual({ count: 2, label: "2 membership applications awaiting review" });
    expect(attentionBadge("doors", counts)).toEqual({ count: 1, label: "1 door needs attention" });
    expect(attentionBadge("faults", counts)).toEqual({ count: 5, label: "5 faults need attention" });
  });
});
