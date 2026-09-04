import { SESSION_ADMIN, serveApi, signIn, test, expect } from "./fixtures";

/**
 * Connecting a board, end to end through the real UI.
 *
 * <p>
 * This is the flow an admin performs standing at a cupboard with a freshly powered
 * box in front of them, and the one that was impossible before: eight device
 * endpoints existed with no screen behind any of them.
 * </p>
 */

const SETTINGS = {
  slice_minutes: 15,
  slice_price_credits: 8,
  advance_booking_days: 14,
  day_start_minute: 360,
  day_end_minute: 1320,
  penalty_pct: 30,
  grace_window_minutes: 5,
  penalty_window_minutes: 15,
  timezone: "Africa/Johannesburg",
  button_map: ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "minutes:60"],
  credits_per_zar_regular: 1.6,
  credits_per_zar_league: 2.4,
  topup_block_zar: 100,
  topup_max_zar_per_member: 1000,
  member_per_day_max_minutes: 60,
  peak_hours: "16:00-19:00",
  peak_advance_hours_for_regular: 1,
  retention_years: 2,
  no_show_lookback_days: 7,
};

const BOARD = {
  mac: "5ccf7f1a2b3c",
  address: "192.168.68.151",
  hardware: "esp8266",
  firmware: "1.0.0",
  mega_version: null,
  claimed: false,
  claimable: true,
  signature_verified: null,
  device_id: null,
  tenant_slug: null,
  first_seen_at: new Date().toISOString(),
  last_seen_at: new Date().toISOString(),
};

const DEVICE = {
  id: "11111111-1111-1111-1111-111111111111",
  device_code: "court-box-1",
  name: "Court 1 box",
  kind: "CourtBox",
  hardware: "Esp8266",
  // Relay order: index 0 is relay A.
  court_numbers: [1],
  gate_key: null,
  mac_address: "5ccf7f1a2b3c",
  key_version: 1,
  enabled: true,
  revoked_at: null,
  last_seen_at: new Date().toISOString(),
  last_ip_address: "192.168.68.151",
  running_version: "1.0.0",
  mega_version: "1.0.0",
  ota_channel: "Stable",
  pinned_version: null,
  failed_version: null,
  created_at: new Date().toISOString(),
};

const COURTS = [
  { id: "22222222-2222-2222-2222-222222222221", court_number: 1, name: "Court 1", court_type: "Squash", slice_price_credits: 8, is_active: true },
  { id: "22222222-2222-2222-2222-222222222222", court_number: 2, name: "Court 2", court_type: "Squash", slice_price_credits: 8, is_active: true },
];

const DISCOVERY = {
  state: "Listening",
  listening: true,
  bound_endpoint: "0.0.0.0:48653",
  detail: null,
  packets_received: 4,
  packets_accepted: 4,
  packets_rejected: 0,
  last_packet_at: new Date().toISOString(),
  started_at: new Date().toISOString(),
  announcers: 1,
  capacity_reached: false,
  hint: null,
};

test.describe("Connecting a board", () => {
  test("an admin sees an announcing board and claims it with the code on its screen", async ({ page }) => {
    await signIn(page);
    await serveApi(page, [
      { path: "/api/v1/whoami", body: SESSION_ADMIN },
      { path: "/api/v1/admin/devices/discovered", body: [BOARD] },
      { path: "/api/v1/admin/devices/discovery-status", body: DISCOVERY },
      { path: "/api/v1/admin/devices/", body: [] },
      { path: "/api/v1/admin/settings/", body: SETTINGS },
      { path: "/api/v1/admin/courts/", body: COURTS },
      { method: "POST", path: "/api/v1/admin/devices/claim", body: { device: DEVICE, device_key: "k", key_version: 1, board: BOARD, note: "" } },
    ]);

    await page.goto("/admin/devices");

    // The board announced itself. Nobody read an IP off a sticker.
    await expect(page.getByText("5ccf7f1a2b3c")).toBeVisible();

    await page.getByLabel("Board 5ccf7f1a2b3c").check();
    await page.getByLabel(/Code on the box/).fill("K7RM4XPT");
    await page.getByLabel("Name").fill("Court 1 box");
    // Courts are assigned per relay, A first — one box drives up to four of them.
    await page.getByLabel("Relay A court").selectOption("1");
    await page.getByRole("button", { name: /Connect this board/ }).click();

    await expect(page.getByText(/Connected Court 1 box/)).toBeVisible();
  });

  test("the button map is eight physical buttons and can be remapped", async ({ page }) => {
    await signIn(page);
    await serveApi(page, [
      { path: "/api/v1/whoami", body: SESSION_ADMIN },
      { path: "/api/v1/admin/devices/discovered", body: [] },
      { path: "/api/v1/admin/devices/discovery-status", body: DISCOVERY },
      { path: "/api/v1/admin/devices/", body: [DEVICE] },
      { path: "/api/v1/admin/settings/", body: SETTINGS },
      { path: "/api/v1/admin/courts/", body: COURTS },
      { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
    ]);

    await page.goto("/admin/devices");

    // The wiring never changes, so button 1 is always the same physical button —
    // swapping courts is a browser action, not a screwdriver one.
    await expect(page.getByLabel("Button 1 action")).toBeVisible();
    await expect(page.getByLabel("Button 8 action")).toBeVisible();

    await page.getByLabel("Button 1 court").selectOption("D");
    await page.getByRole("button", { name: /Save button map/ }).click();

    await expect(page.getByText(/Button map saved/)).toBeVisible();
  });

  test("a board that could not start its firmware is called out", async ({ page }) => {
    await signIn(page);
    await serveApi(page, [
      { path: "/api/v1/whoami", body: SESSION_ADMIN },
      { path: "/api/v1/admin/devices/discovered", body: [] },
      { path: "/api/v1/admin/devices/discovery-status", body: DISCOVERY },
      { path: "/api/v1/admin/devices/", body: [{ ...DEVICE, failed_version: "1.1.0" }] },
      { path: "/api/v1/admin/settings/", body: SETTINGS },
      { path: "/api/v1/admin/courts/", body: COURTS },
    ]);

    await page.goto("/admin/devices");

    // The box already refuses to reinstall it. This is so a person finds out.
    await expect(page.getByText(/firmware 1\.1\.0 failed to start/)).toBeVisible();
  });
});
