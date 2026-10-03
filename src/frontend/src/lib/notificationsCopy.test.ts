import { describe, expect, it } from "vitest";
import { deliveryBadge, lockedBecause, noticeAge } from "./notificationsCopy";

/** The alert feed's words: how old a notice is, and where its email got to. */

const NOW = Date.parse("2026-09-23T12:00:00Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

describe("noticeAge", () => {
  it("counts up in the unit a person reads at a glance", () => {
    expect(noticeAge(ago(20), NOW)).toBe("just now");
    expect(noticeAge(ago(5 * 60), NOW)).toBe("5 minutes ago");
    expect(noticeAge(ago(3 * 3600), NOW)).toBe("3 hours ago");
    expect(noticeAge(ago(26 * 3600), NOW)).toBe("yesterday");
    expect(noticeAge(ago(3 * 86400), NOW)).toBe("3 days ago");
  });

  it("says its unit in words, one or many (R7 J7-3)", () => {
    expect(noticeAge(ago(60), NOW)).toBe("1 minute ago");
    expect(noticeAge(ago(3600), NOW)).toBe("1 hour ago");
  });

  it("gives the club's date past a week, rather than arithmetic", () => {
    expect(noticeAge(ago(10 * 86400), NOW, "Africa/Johannesburg")).toBe("Sun 13 Sep, 14:00");
  });

  it("never says a notice is from the future when two clocks disagree", () => {
    expect(noticeAge(ago(-30), NOW)).toBe("just now");
  });
});

describe("deliveryBadge", () => {
  const delivery = (state: "pending" | "sent" | "suppressed" | "failed", recipients: number | null = 2) =>
    ({ state, sent_at: null, finished_at: null, recipients });

  it("says how many admins were emailed, in words and a tone", () => {
    expect(deliveryBadge(delivery("sent", 1))).toEqual({ label: "Emailed 1 admin", tone: "success" });
    expect(deliveryBadge(delivery("sent", 4))).toEqual({ label: "Emailed 4 admins", tone: "success" });
    expect(deliveryBadge(delivery("sent", null))).toEqual({ label: "Emailed", tone: "success" });
  });

  it("does not call a notice nobody received 'emailed'", () => {
    expect(deliveryBadge(delivery("sent", 0))).toEqual({ label: "No admin to email", tone: "warning" });
  });

  it("names the held-back, the failed and the not-yet-sent apart", () => {
    expect(deliveryBadge(delivery("suppressed")).label).toBe("Not emailed — told recently");
    expect(deliveryBadge(delivery("failed"))).toEqual({ label: "Email failed", tone: "danger" });
    expect(deliveryBadge(delivery("pending")).label).toBe("Sending");
  });
});

describe("lockedBecause", () => {
  it("gives each security kind its own reason, and any other a true one", () => {
    expect(lockedBecause("admin.role_changed")).toMatch(/admin rights/);
    expect(lockedBecause("code.forgery_suspected")).toMatch(/forged code/);
    expect(lockedBecause("some.future_kind")).toMatch(/security/);
  });
});
