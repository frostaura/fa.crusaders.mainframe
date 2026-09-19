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
  gate_unlock_seconds: 3,
  gate_access_policy: "active_member",
  gate_early_entry_minutes: 30,
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

/**
 * A door gate exactly as it arrives: the API generated the code and the name, nobody has
 * named the door, and `auto_registered` is what says so.
 *
 * <p>
 * Written out rather than spread from FRESH, because the fields that differ are the whole
 * point: no courts (the API refuses the field on a Gate row), no button map (a gate's
 * heartbeat carries neither a map nor a config block), an ESP32 rather than the box's
 * ESP8266, and a null `gate_key`.
 * </p>
 */
const GATE = {
  id: "99999999-9999-9999-9999-999999999999",
  device_code: "gate-0a1b2c",
  name: "Door gate",
  kind: "Gate",
  hardware: "Esp32",
  court_numbers: [],
  gate_key: null as string | null,
  mac_address: "5ccf7f0a1b2c",
  enabled: true,
  last_seen_at: new Date().toISOString(),
  last_ip_address: "192.168.68.160",
  running_version: "1.0.0",
  mega_version: null,
  created_at: new Date().toISOString(),
  auto_registered: true,
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

    // "boards", not "boxes". A gate registers itself on this list exactly as a court box
    // does, so a club that has installed a door and nothing else was reading a screen that
    // named a device it does not own. The heading above the list is "Connected boards".
    await expect(page.getByText(/No boards have called in yet/)).toBeVisible();
    await expect(page.getByText(/No boxes have called in yet/)).toHaveCount(0);
    // The instruction has to name the key above it, because that is the only thing that
    // makes a board able to register at all.
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

test.describe("Taking a box out of service", () => {
  /**
   * The control the API, the health sweep and the settlement model were all written
   * around and that no screen offered (finding M-F3). `PeripheralHealthWorker` filters on
   * `Enabled`, so a box that is broken or unplugged for good alerted the club every thirty
   * seconds about a silence nobody could stop; and `DeviceOutageIndex` builds its silence
   * index from enabled boxes alone, so a court whose only box is dead-but-enabled is
   * "dark" for ever and every no-show on it is refunded with no penalty. The only lever
   * the page had was Delete, which the page itself describes as a reset.
   *
   * <p>
   * In a real browser rather than jsdom, because the interaction is a two-step confirm and
   * because what an admin can actually reach on this row is the whole finding.
   * </p>
   */
  test("is a real control, sends only that field, and says what it costs", async ({ page }) => {
    const box = { ...FRESH, name: "Cupboard box", auto_registered: false, court_numbers: [1, 2] };
    await openDevices(page, [box], [
      { method: "PATCH", path: "/api/v1/admin/devices/", body: { ...box, enabled: false } },
    ]);

    const patch = page.waitForRequest((r) => r.method() === "PATCH" && r.url().includes("/admin/devices/"));

    await page.getByRole("button", { name: "Take out of service" }).click();
    // Arms first: a live box stops switching lights on the moment this lands. And the confirm
    // names what this particular box strands — it is the only one in the club, so from the
    // click the API takes nothing from it and courts 1 and 2 stop being penalised. It read the
    // plain "the box stops switching lights on" until round 8 made the label per-court; this
    // file was not updated with it and had been red at HEAD ever since.
    const confirm = page.getByRole("button", {
      name: "Out of service? Nothing else drives courts 1 and 2 — the API stops taking anything from that box,"
        + " and from that instant their no-shows stop being penalised.",
    });
    await expect(confirm).toBeVisible();

    await serveApi(page, routes([{ ...box, enabled: false }], [
      { method: "PATCH", path: "/api/v1/admin/devices/", body: { ...box, enabled: false } },
    ]));
    await confirm.click();

    // Exactly the one field: sending the name and courts alongside would rewrite whatever
    // another admin had just changed on this row.
    expect(JSON.parse((await patch).postData() ?? "{}")).toEqual({ enabled: false });

    // Not "offline" — nobody expects it to call in — and the row says what the club has
    // just given up: alerts about this box, and its courts' outage waiver.
    // Exact, because Playwright's default text match is a case-insensitive substring and
    // the explanation below the row opens with "Out of service." — two matches, and a
    // strict-mode violation that reads as the badge being missing.
    await expect(page.getByText("out of service", { exact: true })).toBeVisible();
    // Which courts are stranded, named per court, rather than the flat "judged by whatever
    // other boxes drive them" — a sentence that named nothing in exactly the state that costs
    // money. Read off the row notice specifically: the toast says the same thing, deliberately
    // (one generator feeds both, so they cannot drift apart), and an unscoped match finds two.
    const notice = page.getByText(/The API refuses this box, so it switches nothing on/);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("No box in service drives courts 1 and 2, so the API turns that hardware away");
    // Not "nobody can check in there", which is what this said for three rounds. The 403 is
    // DeviceIdentity's and covers the four /api/v1/device/ routes; /api/v1/court/{n}/pin,
    // /qr/match and /biometric/match never read a Device row and do check a member in, which
    // is why the refund clause below is qualified rather than flat.
    await expect(notice).not.toContainText("nobody can check in there");
    await expect(notice).toContainText(
      "The courtside PIN, QR and fingerprint terminal is a different machine and still checks members in there");
    // "bookings on them", agreeing with the "their" in the confirm the admin just pressed.
    // The plural arm of that pronoun had never been executed anywhere: round 9's verifier
    // forced it to "it" always and watched vitest stay at 485/485 and this suite at 194/194,
    // so the screen could disagree with itself one line apart with everything green.
    await expect(notice).toContainText(
      "Bookings on them nobody checks in on are refunded in full with no no-show penalty, from the"
      + " instant the switch was thrown until a box is back in service");
    await expect(page.getByRole("button", { name: "Put back in service" })).toBeVisible();
  });

  /**
   * The number of boxes to walk to, in a real browser, because that is where round 9's
   * verifier read the wrong one off the production build.
   *
   * <p>
   * The clause counted COURTS while naming BOXES, so one quiet box driving two courts said
   * "the other boxes that drive them have gone quiet" and two quiet boxes driving one court
   * said "the other box that drives it has gone quiet" — wrong in both directions, on the
   * screen whose entire job is telling an admin which hardware to go and look at. Both arms
   * are here; the exhaustive word-by-word matrix is in `src/lib/deviceCoverage.test.ts`.
   * </p>
   */
  test("counts the quiet boxes an admin has to walk to, not the courts they drive", async ({ page }) => {
    const quiet = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const out = { ...FRESH, name: "Cupboard box", auto_registered: false, enabled: false };

    // One quiet box, two courts: ONE box to walk to.
    await openDevices(page, [
      { ...out, court_numbers: [1, 2] },
      { ...FRESH, id: "33333333-3333-3333-3333-333333333333", device_code: "box-d4e5f6",
        name: "Courts 1 and 2 spare", auto_registered: false, court_numbers: [1, 2], last_seen_at: quiet },
    ]);

    await expect(page.getByText(/The API refuses this box, so it switches nothing on/)).toContainText(
      "Nothing in service is reporting on courts 1 and 2 — the other box that drives them has gone"
      + " quiet — so bookings on them are refunded in full with no no-show penalty until one calls in again.",
    );

    // Two quiet boxes, one court: TWO boxes to walk to. An admin who fixed the one box this
    // used to name would have left the court dark and been told the screen was satisfied.
    await serveApi(page, routes([
      { ...out, court_numbers: [1] },
      { ...FRESH, id: "33333333-3333-3333-3333-333333333333", device_code: "box-d4e5f6",
        name: "Court 1 spare", auto_registered: false, court_numbers: [1], last_seen_at: quiet },
      { ...FRESH, id: "44444444-4444-4444-4444-444444444444", device_code: "box-g7h8i9",
        name: "Court 1 second spare", auto_registered: false, court_numbers: [1], last_seen_at: quiet },
    ]));
    await page.reload();

    await expect(page.getByText(/The API refuses this box, so it switches nothing on/)).toContainText(
      "Nothing in service is reporting on court 1 — the other boxes that drive it have gone quiet"
      + " — so bookings on it are refunded in full with no no-show penalty until one calls in again.",
    );
  });

  /**
   * The reassuring arm of the same sentence, in a real browser, at every one of its four cells.
   *
   * <p>
   * Round 10 changed this clause — it named boxes in the plural at every count, so the
   * commonest shape in a four-box club, one spare still reporting, told an admin there were
   * several — and pinned the change in jsdom only. Standard 3 says a jsdom test does not
   * settle what a page does, and the asymmetry was the point: the quiet clause beside it got a
   * browser test in the same commit and this one did not, so the arm an admin is most likely
   * to act on was the arm no browser had read.
   * </p>
   *
   * <p>
   * Both numbers vary independently — the boxes that are reporting and the courts they cover —
   * so all four cells are here rather than the one a single fixture happens to produce. Each
   * runs at both project widths, mobile and desktop, because that is the whole reason this
   * suite exists in two projects.
   * </p>
   */
  test("names one covering box as one and several as several, at every count", async ({ page }) => {
    const out = { ...FRESH, name: "Cupboard box", auto_registered: false, enabled: false };
    const spare = (id: string, code: string, name: string, courts: number[]) => ({
      ...FRESH, id, device_code: code, name, auto_registered: false, court_numbers: courts,
      last_seen_at: new Date().toISOString(),
    });
    const b = (courts: number[]) => spare("33333333-3333-3333-3333-333333333333", "box-d4e5f6", "Spare one", courts);
    const c = (courts: number[]) => spare("44444444-4444-4444-4444-444444444444", "box-g7h8i9", "Spare two", courts);

    const cells: { courts: number[]; others: number[][]; reads: string }[] = [
      { courts: [1], others: [[1]],
        reads: "Another box is still reporting on court 1, so its no-shows are judged as normal." },
      { courts: [1, 2], others: [[1, 2]],
        reads: "Another box is still reporting on courts 1 and 2, so their no-shows are judged as normal." },
      { courts: [1], others: [[1], [1]],
        reads: "Other boxes are still reporting on court 1, so its no-shows are judged as normal." },
      { courts: [1, 2], others: [[1, 2], [1, 2]],
        reads: "Other boxes are still reporting on courts 1 and 2, so their no-shows are judged as normal." },
    ];

    for (const [index, cell] of cells.entries()) {
      const siblings = [b(cell.others[0]), ...(cell.others[1] ? [c(cell.others[1])] : [])];
      const list = [{ ...out, court_numbers: cell.courts }, ...siblings];
      if (index === 0) await openDevices(page, list);
      else {
        await serveApi(page, routes(list));
        await page.reload();
      }

      const notice = page.getByText(/The API refuses this box, so it switches nothing on/);
      await expect(notice).toContainText(cell.reads);
      // And nothing from the two arms that cost money — this court is covered, so neither the
      // shut-door sentence nor the gone-quiet one belongs on it.
      await expect(notice).not.toContainText("refunded in full");
    }
  });
});

test.describe("The walk-up cap the buttons are held to", () => {
  /**
   * Finding M-F1. The editor validated against the 90-minute relay hard cap and nothing
   * else, so a club that lowered `walk_up_max_minutes` to 20 left every box advertising
   * 15/30/45/60 while the API refused three of the four presses — the club's own
   * configuration change, blamed on the member at a court with nobody at the desk. The
   * string "walk-up" did not appear on this page at all.
   */
  test("is named on the page that sets the buttons, and names the buttons it will refuse", async ({ page }) => {
    await signIn(page);
    await serveApi(page, [
      ...routes([{ ...FRESH, auto_registered: false }]).filter((r) => r.path !== "/api/v1/admin/settings/"),
      { path: "/api/v1/admin/settings/", body: { ...SETTINGS, walk_up_max_minutes: 20 } },
    ]);
    await page.goto("/admin/devices");

    // The club map's buttons 6 and 7 are 30 and 45; button 8 is "off" and grants nothing.
    await expect(page.getByText(/Buttons 6, 7 grant more than this club's walk-up maximum of 20 minutes/)).toBeVisible();
    await expect(page.getByText(/Raise Walk-up maximum \(minutes\) under Admin settings/)).toBeVisible();

    // A warning, not a refusal: the cap can be raised afterwards, and blocking the save
    // would deadlock this screen against the Settings screen.
    await expect(page.getByRole("button", { name: "Save button map" })).toBeEnabled();
  });
});

/**
 * A door gate on the same screen as the boxes.
 *
 * <p>
 * In a real browser rather than only in jsdom, and at both project widths, because both
 * halves of what this row does are things a jsdom test cannot settle. The interactions are
 * two-step confirms whose armed labels are the copy itself; and the row carries the two
 * widest tokens on the page — a device name and a 64-character door name — on a screen that
 * has pushed itself wider than a phone on a long name before (R2 I-F6). Standard 3 here is
 * that a jsdom test does not settle what a page does.
 * </p>
 */
test.describe("A door gate", () => {
  test("reads as a door, offers only the door's own editor, and names the door on save", async ({ page }) => {
    await openDevices(page, [GATE], [
      { method: "PATCH", path: "/api/v1/admin/devices/", body: { ...GATE, name: "Front door", gate_key: "front-door", auto_registered: false } },
    ]);

    // What it is, and which door — including the unnamed state every door in the club is
    // actually in the first time an admin opens this screen.
    await expect(page.getByText("gate-0a1b2c · Door gate · no door name yet · 5ccf7f0a1b2c")).toBeVisible();
    // The badge asks for the job a door has, not the one a box has.
    await expect(page.getByText("New — name this door")).toBeVisible();
    await expect(page.getByText("New — check court numbers")).toHaveCount(0);

    // Neither court editor nor button editor, and no kind selector. The API refuses court
    // fields on a Gate row and has no member for kind at all, so an editor for either would
    // be a form whose save can only fail.
    await expect(page.getByRole("button", { name: "Edit name and courts" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit buttons" })).toHaveCount(0);

    await page.getByRole("button", { name: "Edit name and door" }).click();
    await expect(page.getByLabel("box-a1b2c3 relay A court")).toHaveCount(0);

    await page.getByLabel("Name", { exact: true }).fill("Front door");
    await page.getByLabel("Door name", { exact: true }).fill("front-door");

    const patch = page.waitForRequest((r) => r.method() === "PATCH" && r.url().includes("/admin/devices/"));
    await serveApi(page, routes([{ ...GATE, name: "Front door", gate_key: "front-door", auto_registered: false }], [
      { method: "PATCH", path: "/api/v1/admin/devices/", body: { ...GATE, name: "Front door", gate_key: "front-door", auto_registered: false } },
    ]));
    await page.getByRole("button", { name: "Save door" }).click();

    // Name and door key in one call, and no court_numbers — the API refuses that field here.
    expect(JSON.parse((await patch).postData() ?? "{}")).toEqual({ name: "Front door", gate_key: "front-door" });
    await expect(page.getByRole("status")).toContainText("Front door is the front-door door.");
    await expect(page.getByText("New — name this door")).toBeHidden();
  });

  /**
   * The out-of-service copy, which is the door's own and shares nothing with the box's.
   *
   * <p>
   * The middle clause is the one a shorter sentence gets wrong, and the one this test exists
   * for — and it is now a PAIR of clauses rather than one. A 403 is authoritative for a gate:
   * a board that reaches the API and is refused denies the scan with no roster fallback, and
   * a 403 on its heartbeat commits an empty roster, so a door that is merely out of service
   * on a working network really does open for nobody. A board that has ALSO lost the network
   * never hears any of it and keeps admitting booked members from its cache for up to six
   * hours. Either half stated alone is a sentence an admin cannot reconcile with what they
   * will see, which is the same class of falsehood as the box side's "nobody can check in
   * there" — that one survived three rounds and was read off a production build.
   * </p>
   */
  test("says what taking a DOOR out of service costs, and none of what it costs a box", async ({ page }) => {
    const door = { ...GATE, name: "Front door", gate_key: "front-door", auto_registered: false };
    await openDevices(page, [door], [
      { method: "PATCH", path: "/api/v1/admin/devices/", body: { ...door, enabled: false } },
    ]);

    const patch = page.waitForRequest((r) => r.method() === "PATCH" && r.url().includes("/admin/devices/"));

    await page.getByRole("button", { name: "Take out of service" }).click();
    const confirm = page.getByRole("button", {
      name: "Out of service? A door that can reach the API opens for nobody from this click. One that"
        + " has also lost the network keeps admitting booked members from its cached roster for up to"
        + " six hours. No booking, check-in or no-show penalty changes.",
    });
    await expect(confirm).toBeVisible();
    // Never the box's, which promises a court's no-shows stop being penalised.
    await expect(page.getByRole("button", { name: /Nothing else drives/ })).toHaveCount(0);

    await serveApi(page, routes([{ ...door, enabled: false }], [
      { method: "PATCH", path: "/api/v1/admin/devices/", body: { ...door, enabled: false } },
    ]));
    await confirm.click();

    expect(JSON.parse((await patch).postData() ?? "{}")).toEqual({ enabled: false });

    // Read off the row notice specifically: the toast says the same thing, deliberately —
    // one generator feeds both — and an unscoped match on the shared half finds two, which
    // is a strict-mode violation reading as the notice being absent. Anchored at the start,
    // where the two differ: the row opens "Out of service.", the toast "<name> is out of
    // service." Written unanchored first, and this run is what caught it.
    const notice = page.getByText(/^Out of service\. The club is not alerted/);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("the API refuses every scan at this door");
    // Both halves — the reachable door that opens for nobody, and the cut-off one that does
    // not hear the refusal and keeps admitting booked members until its roster goes stale.
    await expect(notice).toContainText("can still reach the API hears that refusal and opens for nobody");
    await expect(notice).toContainText("has also lost the network never hears it");
    await expect(notice).toContainText("roster it last downloaded");
    await expect(notice).toContainText("up to six hours");
    await expect(notice).toContainText(
      "Bookings, check-ins, refunds and no-show penalties are untouched either way");
    // And none of the court-box copy, which is about courts going dark and penalties being
    // waived and is false of a door in every clause.
    await expect(notice).not.toContainText("refunded in full");
    await expect(notice).not.toContainText("No box in service drives");
    await expect(page.getByText(/The API refuses this box/)).toHaveCount(0);

    // Deleting a door loses its name, which is what the label has to say.
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("button", {
      name: "Delete? The door re-registers on its next heartbeat with no name.",
    })).toBeVisible();
  });

  /**
   * <b>Clearing a door's name, against a server that behaves like the API.</b>
   *
   * <p>
   * The screen sent `gate_key: null`, which `DeviceRegistryService.UpdateAsync` reads as
   * "leave it alone" — it applies the field only <code>if (cmd.GateKey is not null)</code>,
   * and <code>Length == 0</code> is what stores a null. So the clear was a silent no-op that
   * reported success, and neither this spec nor the unit test could see it: both answered
   * the PATCH with an already-cleared row whatever they were handed.
   * </p>
   *
   * <p>
   * The route below applies the API's own rule to whatever arrives, and the list route
   * serves what it produced, so the assertion is on the OUTCOME rather than on the wire text
   * alone. Sending null leaves the row reading "front-door" after the reload — which is
   * exactly what an admin saw.
   * </p>
   */
  test("clears a door name for real, rather than reporting a save the API discards", async ({ page }) => {
    let row: Record<string, unknown> = {
      ...GATE, name: "Front door", gate_key: "front-door", auto_registered: false,
    };
    const gateKeyAware: ApiRoute[] = [
      { path: "/api/v1/admin/devices/", respond: () => [row] },
      {
        method: "PATCH",
        path: "/api/v1/admin/devices/",
        respond: (request) => {
          const patch = (request.body ?? {}) as Record<string, unknown>;
          // The API's rule, verbatim: null is an absence, "" is the clear.
          if (typeof patch.name === "string") row = { ...row, name: patch.name };
          if (typeof patch.gate_key === "string") {
            const trimmed = patch.gate_key.trim();
            row = { ...row, gate_key: trimmed === "" ? null : trimmed };
          }
          return row;
        },
      },
    ];

    await signIn(page);
    await serveApi(page, [...routes([]).filter((r) => r.path !== "/api/v1/admin/devices/"), ...gateKeyAware]);
    await page.goto("/admin/devices");
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
    await expect(page.getByText("Door gate · front-door")).toBeVisible();

    const patch = page.waitForRequest((r) => r.method() === "PATCH" && r.url().includes("/admin/devices/"));
    await page.getByRole("button", { name: "Edit name and door" }).click();
    await page.getByLabel("Door name", { exact: true }).fill("   ");
    await page.getByRole("button", { name: "Save door" }).click();

    // The wire value the API honours, and then the row it actually produced.
    expect(JSON.parse((await patch).postData() ?? "{}")).toEqual({ name: "Front door", gate_key: "" });
    await expect(page.getByText("Door gate · no door name yet")).toBeVisible();
    await expect(page.getByText("Door gate · front-door")).toHaveCount(0);

    // And what the club has just given up, which is no longer only the audit trail: an
    // unnamed door is sent an empty roster, so it has no offline fallback at all.
    await expect(page.getByRole("status")).toContainText("only works while it can reach the server");
    await expect(page.getByText(/^Until you name this door/)).toBeVisible();
  });

  /**
   * <b>The row must not widen the page.</b> A 64-character door name is the longest
   * unbreakable token this screen can be asked to render, and the mobile project is 412 px
   * wide. Measured as a horizontal overflow of the document rather than as a class name,
   * because the class is what a jsdom test can already see and the overflow is what an
   * admin actually experiences.
   */
  test("does not push the page sideways on a 64-character door name", async ({ page }) => {
    const longKey = "back-staircase-changing-room-corridor-door-by-the-fire-exit-0123";
    expect(longKey).toHaveLength(64);

    await openDevices(page, [{
      ...GATE,
      auto_registered: false,
      name: "The changing room corridor door by the back staircase",
      gate_key: longKey,
    }]);

    await expect(page.getByText(new RegExp(longKey))).toBeVisible();
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  /**
   * A gate and a box on one list, which is the club's real shape — and the arrangement where
   * a missing kind filter costs money. A door on a court's wall counted as a box in service
   * on that court would make the court read as covered, so taking the club's only court box
   * out of service would confirm with the plain "the box stops switching lights on" while
   * the ledger stopped penalising that court's no-shows.
   */
  test("never counts as cover for a court, even carrying a court number", async ({ page }) => {
    const box = { ...FRESH, name: "Court 1 box", auto_registered: false, court_numbers: [1] };
    // A court number on a Gate row, which the API never sends and a hand-edited row could.
    // The filter is on kind, so this changes nothing.
    await openDevices(page, [box, { ...GATE, auto_registered: false, court_numbers: [1] }]);

    await expect(page.getByText("Door gate · no door name yet")).toBeVisible();
    await expect(page.getByText("box-a1b2c3 · A: court 1 · 5ccf7f1a2b3c")).toBeVisible();

    await page.getByRole("button", { name: "Take out of service" }).first().click();
    await expect(page.getByRole("button", { name: /Nothing else drives court 1/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /The box stops switching lights on/ })).toHaveCount(0);
  });
});
