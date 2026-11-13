import { describe, expect, it } from "vitest";
import { AFTER_SWITCH_PATH, landingAfterSwitch } from "./switchClub";

/** BA-12: switching live/demo keeps an admin on the console page they were on. */
describe("where a club switch lands", () => {
  it("stays on the admin page, query kept", () => {
    expect(landingAfterSwitch("demo", "/admin/settings", "?q=lcd")).toBe("/admin/settings?q=lcd");
    expect(landingAfterSwitch("live", "/admin/monitoring", "")).toBe("/admin/monitoring");
  });

  it("goes to the console's start from a page that names one of this club's records", () => {
    expect(landingAfterSwitch("demo", "/admin/members/44444444-4444-4444-4444-444444444444/wallet", "")).toBe("/admin");
  });

  it("lands on My Code for the member view, or from outside the console", () => {
    expect(landingAfterSwitch("demo_member", "/admin/settings", "")).toBe(AFTER_SWITCH_PATH);
    expect(landingAfterSwitch("demo", "/book", "")).toBe(AFTER_SWITCH_PATH);
    expect(landingAfterSwitch("live", "/administer", "")).toBe(AFTER_SWITCH_PATH);
  });
});
