import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage, stubFetch } from "../../test/harness";
import type { AdminSettings } from "../../lib/api";
import { ScreensPreview } from "./ScreensPreview";

/**
 * Settings › Box screens' preview (FA-6): the start screen in both layouts, from the courts' lights
 * now. Three states — still reading, a failed read that draws nothing, and the glass itself.
 */

const settings = (extra: Partial<AdminSettings> = {}) => ({
  lcd_layout: "compact", lcd_marquee_enabled: false, ...extra,
} as unknown as AdminSettings);

const BOARD = {
  generated_at: "2026-11-13T18:05:00Z",
  timezone: "Africa/Johannesburg",
  courts: [
    { court_id: "c1", court_number: 1, name: "Court 1", lights: { state: "on", seconds_remaining: 2700 } },
    { court_id: "c2", court_number: 2, name: "Court 2", lights: { state: "off" } },
    { court_id: "c3", court_number: 3, name: "Court 3", lights: { state: "unknown" } },
  ],
  boxes: [{
    device_id: "d1", device_code: "box-a1", name: "Box by the door", mac_address: null, enabled: true,
    link: "online", last_seen_at: null, court_numbers: [2, 1],
  }],
};

describe("the start-screen preview", () => {
  it("draws one box's courts in relay order, both layouts, marking the one in force", async () => {
    stubFetch([{ path: "/api/v1/admin/control-board", body: BOARD }]);
    renderPage(<ScreensPreview settings={settings({ lcd_layout: "expanded" })} />);

    const expanded = await screen.findByRole("img", { name: /^Expanded, 20×4/ });
    // Relay order is the box's [2, 1], the lit court's minutes are the lights' own, no names.
    expect(expanded).toHaveAccessibleName(/SCAN YOUR QR CODE\. COURT 2 +OFF\. COURT 1 +ON 45 MIN/);
    expect(expanded.getAttribute("aria-label")).not.toMatch(/Box by the door/);
    expect(screen.getByRole("img", { name: /^Compact, 16×2/ })).toHaveAccessibleName(/SCAN YOUR QR\. COURT 2 +OFF/);
    expect(screen.getByText(/Expanded, 20×4 — in force/)).toBeInTheDocument();
    expect(screen.queryByText(/Compact, 16×2 — in force/)).toBeNull();
    expect(screen.getByText(/Box by the door's courts/)).toBeInTheDocument();
  });

  it("follows the unsaved layout: compact in force when the draft says compact", async () => {
    stubFetch([{ path: "/api/v1/admin/control-board", body: BOARD }]);
    renderPage(<ScreensPreview settings={settings({ lcd_layout: "something-new" })} />);
    // Anything but expanded is compact, as on the box.
    expect(await screen.findByText(/Compact, 16×2 — in force/)).toBeInTheDocument();
  });

  it("says a failed read, offers a retry, and draws no glass", async () => {
    stubFetch([{ path: "/api/v1/admin/control-board", status: 503, body: { error: "unavailable" } }]);
    renderPage(<ScreensPreview settings={settings()} />);
    expect(await screen.findByText(/read the courts' lights/i)).toBeInTheDocument();
    expect(screen.getByText(/so it is not drawn/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("says it is reading while the board has not answered", async () => {
    stubFetch([{ path: "/api/v1/admin/control-board", body: BOARD }]);
    renderPage(<ScreensPreview settings={settings()} />);
    expect(screen.getByText(/Reading the courts' lights/)).toBeInTheDocument();
    expect(await screen.findAllByRole("img")).toHaveLength(2);
  });
});
