import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * The Devices screen, driven against the device contract the product actually has.
 *
 * <p>
 * <b>What this file used to test, and why it was deleted.</b> Every test here described a
 * discovery listener the box announced itself to over UDP, a claim code read off the box's
 * LCD, and a per-device key issued once on claim. None of it exists: the simplification
 * replaced the lot with one static club API key flashed into every box's
 * <code>secrets.h</code> and self-registration on the first heartbeat. The specs went on
 * calling <code>/admin/devices/discovered</code>, <code>/discovery-status</code> and
 * <code>/claim</code> — three endpoints with no server behind them — and had been failing
 * six times a run ever since, on a job that gates every deploy. Which is the finding worth
 * writing down: <b>the E2E suite was never re-run after the contract changed</b>, so the
 * only thing standing between a deleted feature and a green pipeline was a job nobody read.
 * </p>
 *
 * <p>
 * What is below is the screen's three real jobs — hand the admin the club key, show what
 * has registered itself, decide what the buttons mean — plus the two that follow from
 * self-registration: the "New" badge that says a live box is probably pointing at the wrong
 * courts, and a delete that forgets a row rather than locking a box out.
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
  button_map: ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "off"],
  operating_hours: { mon: "06:00-22:00", sat: "07:00-20:00" },
  credits_per_zar_regular: 1.6,
  credits_per_zar_league: 2.4,
  topup_block_zar: 100,
  topup_max_zar_per_member: 1000,
  member_per_day_max_minutes: 60,
  peak_hours: "16:00-19:00",
  peak_advance_hours_for_regular: 1,
  retention_years: 2,
  no_show_lookback_days: 7,
  walk_up_max_minutes: 90,
  heartbeat_seconds: 60,
  activation_forward_window_minutes: 120,
  activation_cue_window_minutes: 10,
  qr_lifetime_seconds: 60,
  roster_window_minutes: 120,
};

/**
 * A box exactly as it arrives: the API generated the name and the courts, nobody has
 * looked at it, and `auto_registered` is what says so.
 */
const FRESH = {
  id: "11111111-1111-1111-1111-111111111111",
  device_code: "box-a1b2c3",
  name: "box-a1b2c3",
  kind: "CourtBox",
  hardware: "Esp8266",
  // Relay order: index 0 is relay A. One box drives up to four courts.
  court_numbers: [1],
  gate_key: null,
  mac_address: "5ccf7f1a2b3c",
  enabled: true,
  last_seen_at: new Date().toISOString(),
  last_ip_address: "192.168.68.151",
  running_version: "2.0.0",
  mega_version: "1.4.0",
  created_at: new Date().toISOString(),
  auto_registered: true,
  button_map: null,
  effective_heartbeat_seconds: 60,
};

const COURTS = [
  { id: "22222222-2222-2222-2222-222222222221", court_number: 1, name: "Show court", court_type: "Squash", slice_price_credits: 8, is_active: true },
  { id: "22222222-2222-2222-2222-222222222222", court_number: 2, name: "Back court", court_type: "Squash", slice_price_credits: 8, is_active: true },
];

const API_KEY = { api_key: "cmk_9F2Kq7Xd4bTn6Ls0", regenerated_at: "2026-09-01T08:30:00Z" };

/** The routes every rendering of this screen needs, with the device list swapped in. */
function routes(devices: unknown[], extra: ApiRoute[] = []): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@sample.local", photo_url: null, membership_number: "ADMIN-0001", member_class: "Regular" } },
    // Longest prefix wins in the fixture, so the api-key routes are not swallowed by the
    // list route they sit under.
    { path: "/api/v1/admin/devices/api-key", body: API_KEY },
    { path: "/api/v1/admin/devices/", body: devices },
    { path: "/api/v1/admin/settings/", body: SETTINGS },
    { path: "/api/v1/admin/courts/", body: COURTS },
    ...extra,
  ];
}

async function openDevices(page: Page, devices: unknown[], extra: ApiRoute[] = []) {
  await signIn(page);
  await serveApi(page, routes(devices, extra));
  await page.goto("/admin/devices");
  await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
}

test.describe("A box that registered itself", () => {
  test("arrives flagged, and the flag clears only once an admin has set its name and courts", async ({ page }) => {
    await openDevices(page, [FRESH], [
      { method: "PATCH", path: "/api/v1/admin/devices/", body: { ...FRESH, name: "Cupboard box", court_numbers: [1, 2], auto_registered: false } },
    ]);

    // The whole point of the badge: the box is live, and its relays almost certainly
    // point at the wrong courts until somebody has looked.
    await expect(page.getByText("New — check court numbers")).toBeVisible();
    await expect(page.getByText("box-a1b2c3 · A: court 1 · 5ccf7f1a2b3c")).toBeVisible();

    await page.getByRole("button", { name: "Edit name and courts" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Cupboard box");
    // Courts are assigned per relay, A first, in the order they are wired.
    await page.getByLabel("box-a1b2c3 relay A court").selectOption("1");
    await page.getByLabel("box-a1b2c3 relay B court").selectOption("2");

    // The name and the courts are one save because they are one job — a second panel
    // would be a second chance to clear the badge with half the work done.
    const patch = page.waitForRequest((r) => r.method() === "PATCH" && r.url().includes("/admin/devices/"));

    // From here the API answers with the edited row, so the reload after the save shows
    // what a real one would. Registered after the first load, because Playwright matches
    // the most recently added route first.
    await serveApi(page, routes([{ ...FRESH, name: "Cupboard box", court_numbers: [1, 2], auto_registered: false }], [
      { method: "PATCH", path: "/api/v1/admin/devices/", body: { ...FRESH, name: "Cupboard box", court_numbers: [1, 2], auto_registered: false } },
    ]));

    await page.getByRole("button", { name: "Save box" }).click();

    expect(JSON.parse((await patch).postData() ?? "{}")).toEqual({ name: "Cupboard box", court_numbers: [1, 2] });
    await expect(page.getByRole("status")).toContainText("Cupboard box now drives A: court 1, B: court 2.");
    await expect(page.getByText("New — check court numbers")).toBeHidden();
  });

  test("cannot be given a gap in its relay bank", async ({ page }) => {
    await openDevices(page, [{ ...FRESH, court_numbers: [] }]);

    await page.getByRole("button", { name: "Edit name and courts" }).click();

    // `court_numbers` is positional, so a gap is a relay index the API cannot represent.
    // Relay B is unreachable until A is set, rather than reachable and then refused.
    await expect(page.getByLabel("box-a1b2c3 relay A court")).toBeEnabled();
    await expect(page.getByLabel("box-a1b2c3 relay B court")).toBeDisabled();
    // And with no court on any relay there is nothing to save.
    await expect(page.getByRole("button", { name: "Save box" })).toBeDisabled();

    await page.getByLabel("box-a1b2c3 relay A court").selectOption("2");
    await expect(page.getByLabel("box-a1b2c3 relay B court")).toBeEnabled();
    await expect(page.getByRole("button", { name: "Save box" })).toBeEnabled();

    // Clearing A clears everything after it, so the list stays contiguous.
    await page.getByLabel("box-a1b2c3 relay A court").selectOption("");
    await expect(page.getByLabel("box-a1b2c3 relay B court")).toBeDisabled();
  });

  test("until one has, the empty club says what to do instead of showing nothing", async ({ page }) => {
    await openDevices(page, []);

    await expect(page.getByText(/No boxes have called in yet/)).toBeVisible();
    // The instruction has to name the key above it, because that is the only thing that
    // makes a box able to register at all.
    await expect(page.getByText(/Flash one with the key above and power it on/)).toBeVisible();
  });
});

test.describe("Online and offline", () => {
  /**
   * Review finding 22, in a real browser: a club that raises the heartbeat interval to
   * reduce chatter used to watch its whole fleet read offline for most of every interval,
   * because the screen compared against a frozen 180 s while the box ran the tenant's
   * number clamped to 15-300 s.
   */
  test("a quiet box is judged against the cadence it actually runs, not a frozen literal", async ({ page }) => {
    const seenAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString();

    await openDevices(page, [
      // 600 s asked for, 300 s is what the firmware runs, so three missed beats is 900 s
      // and a box four minutes quiet is simply between heartbeats.
      { ...FRESH, id: "aaaaaaaa-0000-0000-0000-000000000001", name: "Slow box", device_code: "box-slow", court_numbers: [1], auto_registered: false, effective_heartbeat_seconds: 600, last_seen_at: seenAgo(240) },
      // The API's own arithmetic wins where it is sent.
      { ...FRESH, id: "aaaaaaaa-0000-0000-0000-000000000002", name: "Dark box", device_code: "box-dark", court_numbers: [2], auto_registered: false, offline_after_seconds: 180, last_seen_at: seenAgo(600) },
    ]);

    const slow = page.locator("div").filter({ hasText: /^Slow box/ }).first();
    await expect(slow.getByText("online")).toBeVisible();

    await expect(page.getByText("last seen 10m ago")).toBeVisible();
  });
});

test.describe("The club's device API key", () => {
  test("rests masked, reveals on demand, and copies", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await openDevices(page, [FRESH]);

    const key = page.getByLabel("Device API key", { exact: true });
    // Four characters each end answers "is this the one I flashed?"; a mask that leaked
    // the length would be a free bit of the secret.
    await expect(key).toHaveText("cmk_••••••••6Ls0");

    await page.getByRole("button", { name: "Reveal device API key" }).click();
    await expect(key).toHaveText(API_KEY.api_key);

    await page.getByRole("button", { name: "Copy device API key" }).click();
    await expect(page.getByRole("button", { name: "Copy device API key" })).toContainText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(API_KEY.api_key);
  });

  test("cannot be regenerated by one tap, and says what regenerating costs", async ({ page }) => {
    await openDevices(page, [FRESH], [
      { method: "POST", path: "/api/v1/admin/devices/api-key/regenerate", body: { api_key: "cmk_NEWNEWNEWNEW1234", regenerated_at: new Date().toISOString() } },
    ]);

    // Regenerating bricks every box until it is reflashed, so the control arms first.
    await page.getByRole("button", { name: "Regenerate key" }).click();
    await expect(page.getByRole("button", { name: /Reflash every box after this/ })).toBeVisible();
    await page.getByRole("button", { name: /Reflash every box after this/ }).click();

    await expect(page.getByRole("status")).toContainText("New key issued.");
    await expect(page.getByRole("status")).toContainText("every box has to be reflashed with this one");
    // And the panel now holds the new key, not the one that just stopped working.
    await page.getByRole("button", { name: "Reveal device API key" }).click();
    await expect(page.getByLabel("Device API key", { exact: true })).toHaveText("cmk_NEWNEWNEWNEW1234");
  });
});

test.describe("The button map", () => {
  test("is eight physical buttons and can be remapped without a screwdriver", async ({ page }) => {
    await openDevices(page, [FRESH], [{ method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } }]);

    // The wiring never changes, so button 1 is always the same physical button.
    await expect(page.getByLabel("Button 1 action")).toBeVisible();
    await expect(page.getByLabel("Button 8 action")).toBeVisible();
    await expect(page.getByLabel("Button 8 action")).toHaveValue("off");

    await page.getByLabel("Button 1 court").selectOption("D");

    const put = page.waitForRequest((r) => r.method() === "PUT" && r.url().includes("/admin/settings/"));
    await page.getByRole("button", { name: "Save button map" }).click();
    const body = JSON.parse((await put).postData() ?? "{}");

    await expect(page.getByRole("status")).toContainText("Button map saved.");

    expect(body.buttonMap).toEqual(["court:D", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "off"]);
    // Review finding 23: this screen used to PUT the whole settings document it read at
    // mount, so saving a remapped button silently reverted whatever another tab had
    // changed since. It now sends only the map plus the eight booking fields the API
    // requires on every PUT — an absent key is read as unchanged, so nothing else can be
    // clobbered. A key here that this screen does not own is that regression coming back.
    expect(Object.keys(body).sort()).toEqual([
      "advanceBookingDays", "buttonMap", "dayEndMinute", "dayStartMinute",
      "graceWindowMinutes", "penaltyPct", "penaltyWindowMinutes", "sliceMinutes", "slicePriceCredits",
    ]);
  });

  test("refuses a grant longer than the relay bank will hold", async ({ page }) => {
    await openDevices(page, [FRESH]);

    // The relay's own timer opens at ninety minutes whatever the grant said, so a button
    // set to more sells darkness — paid for, with no refund and no re-light path.
    await page.getByLabel("Button 5 minutes").fill("240");
    await expect(page.getByText("1–90 minutes — the relay cuts the lights at 90.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save button map" })).toBeDisabled();

    await page.getByLabel("Button 5 minutes").fill("90");
    await expect(page.getByRole("button", { name: "Save button map" })).toBeEnabled();
  });

  test("a box may keep its own map, and an API that does not send the field offers no editor", async ({ page }) => {
    await openDevices(page, [
      { ...FRESH, name: "Own map box", auto_registered: false, button_map: ["off", "off", "off", "off", "off", "off", "off", "off"] },
    ], [
      { method: "PATCH", path: "/api/v1/admin/devices/", body: { ...FRESH, name: "Own map box", auto_registered: false, button_map: null } },
    ]);

    await expect(page.getByText("own button map")).toBeVisible();
    await page.getByRole("button", { name: "Edit buttons" }).click();

    const patch = page.waitForRequest((r) => r.method() === "PATCH" && r.url().includes("/admin/devices/"));
    await page.getByRole("radio", { name: "Use the club's button map" }).check();
    await page.getByRole("button", { name: "Save buttons" }).click();

    // Three-valued on the wire: a list sets an override, null goes back to the club's map.
    expect(JSON.parse((await patch).postData() ?? "{}")).toEqual({ button_map: null });
    await expect(page.getByRole("status")).toContainText("uses the club's button map again");
  });

  test("an older API that sends no button_map field gets no per-box editor at all", async ({ page }) => {
    const { button_map: _omitted, ...noField } = FRESH;
    await openDevices(page, [{ ...noField, auto_registered: false }]);

    // Presence-gated: an editor whose save would bind to nothing must not be offered.
    await expect(page.getByRole("button", { name: "Edit name and courts" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit buttons" })).toHaveCount(0);
  });
});

test.describe("Deleting a box", () => {
  test("says it forgets a row rather than locking a box out, and the box comes back", async ({ page }) => {
    await openDevices(page, [{ ...FRESH, name: "Cupboard box", auto_registered: false }], [
      { method: "DELETE", path: "/api/v1/admin/devices/", body: { deleted: true } },
    ]);

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    // "Really delete?" would let an admin think they had taken a box off the network.
    // It still holds the club's key, so the next heartbeat makes a new row.
    await expect(page.getByRole("button", { name: /The box re-registers on its next heartbeat/ })).toBeVisible();

    // The list the reload reads: the box is back, unnamed and flagged again.
    await serveApi(page, routes([FRESH], [{ method: "DELETE", path: "/api/v1/admin/devices/", body: { deleted: true } }]));
    await page.getByRole("button", { name: /The box re-registers on its next heartbeat/ }).click();

    await expect(page.getByRole("status")).toContainText("it re-registers on its next heartbeat as a new box");
    await expect(page.getByText("New — check court numbers")).toBeVisible();
  });
});
