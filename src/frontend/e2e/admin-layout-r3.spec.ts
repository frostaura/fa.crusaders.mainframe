import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";

/**
 * Review round 3 (lane F3) — admin layout measured in Chromium, which jsdom cannot do.
 *
 * <p>
 * X-4: at 200 % text on a 390 px phone admin pages scrolled sideways — non-wrapping header
 * buttons ("Create a repeating booking", "New endpoint"), a rem floor on the Transactions search,
 * two fixed total columns narrower than "+68473.00", and a court row that could not wrap. V-4:
 * the member Bookings card's Cancel ran past the card at 320. V-6: "433.00 cr" broke over two
 * lines at 768. V-7: the Night export note was squeezed beside its button at 320. V-5:
 * "Regenerate key" broke mid-word at 1280. V-13: the Settings save bar covered the error under
 * the field being fixed at 1280.
 * </p>
 */

const SHELL: ApiRoute[] = [
  { path: "/api/v1/whoami", body: SESSION_ADMIN },
  { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@test.local", photo_url: null, membership_number: "A-1" } },
  { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 10 } },
  { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
];

async function open(page: Page, path: string, routes: ApiRoute[], { width = 390, bigText = false } = {}) {
  await page.setViewportSize({ width, height: 844 });
  await signIn(page);
  await page.addInitScript(() => window.localStorage.setItem("crusaders:settings-intro-dismissed", "1"));
  await serveApi(page, [...SHELL, ...routes]);
  await page.goto(path);
  if (bigText) await page.addStyleTag({ content: "html { font-size: 32px; }" });
}

/**
 * Every page here is a lazy chunk ("Opening the page…"); on a loaded machine the first one took
 * longer than the 5 s default to arrive, so the first wait in each test allows for it.
 */
const ARRIVES = { timeout: 20_000 };

/** How far the page scrolls sideways — the app shell scrolls `<main>`, not the document. */
async function sideways(page: Page): Promise<number> {
  return page.evaluate(() => {
    const main = document.getElementById("main-content")!;
    const doc = document.documentElement;
    return Math.max(main.scrollWidth - main.clientWidth, doc.scrollWidth - doc.clientWidth);
  });
}

/** Whether a button's label is inside its own box — a fixed height under wrapped text is not. */
async function labelInside(page: Page, name: RegExp): Promise<boolean> {
  return page.getByRole("button", { name }).first().evaluate((el) => {
    const box = el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el.querySelector("[data-slot=button-label]") ?? el);
    const text = range.getBoundingClientRect();
    return text.top >= box.top - 1 && text.bottom <= box.bottom + 1;
  });
}

const LEDGER_ROW = (id: string, signed: number) => ({
  id, at: "2026-01-15T10:00:00Z", from: "Club treasury", to: "Nomvula Dlamini-Hendricks",
  amountMinutes: Math.abs(signed), signedAmountMinutes: signed, type: "AdminTopUp", comment: "Desk top-up",
  subjectUserId: "m1", subjectName: "Nomvula Dlamini-Hendricks", actorUserId: "a1", actorName: "Desk Volunteer",
  relatedBookingId: null,
});

test.describe("X-4: admin pages at 200 % text on a 390 px phone", () => {
  test("Repeating bookings: the create button wraps inside itself and nothing scrolls sideways", async ({ page }) => {
    await open(page, "/admin/schedules", [{ path: "/api/v1/admin/schedules", body: { schedules: [], timezone: "Africa/Johannesburg" } }], { bigText: true });
    await expect(page.getByRole("button", { name: /Create a repeating booking/ })).toBeVisible(ARRIVES);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
    expect(await labelInside(page, /Create a repeating booking/), "the label runs out of its button").toBe(true);
  });

  test("Webhooks: New endpoint and the variable catalogue stay on the screen", async ({ page }) => {
    await open(page, "/admin/webhooks", [{ path: "/api/v1/admin/webhooks/", body: [] }], { bigText: true });
    await expect(page.getByRole("button", { name: /New endpoint/ })).toBeVisible(ARRIVES);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
    expect(await labelInside(page, /New endpoint/)).toBe(true);
  });

  test("Courts: a row wraps its status and Edit under the name", async ({ page }) => {
    const courts = [1, 2].map((n) => ({
      id: `2222222${n}-2222-2222-2222-222222222222`, court_number: n, name: `Court ${n}`, court_type: "Squash", slice_price_credits: 50, is_active: true,
    }));
    await open(page, "/admin/courts", [{ path: "/api/v1/admin/courts/", body: courts }], { bigText: true });
    await expect(page.getByRole("button", { name: "Edit Court 1" })).toBeVisible(ARRIVES);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });

  test("Transactions: the search and the big totals fit", async ({ page }) => {
    await open(page, "/admin/ledger?from=2026-01-01&to=2026-01-31", [
      { path: "/api/v1/admin/ledger/", body: [LEDGER_ROW("1", 68473), LEDGER_ROW("2", -15556)] },
    ], { bigText: true });
    await expect(page.locator("[data-ledger-total]").first()).toBeVisible(ARRIVES);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });
});

const MEMBER_ID = "bbbbbbbb-0000-4000-8000-00000000000b";
const MEMBER = `/api/v1/admin/members/${MEMBER_ID}`;
const BOOKING = {
  booking_id: "b1", court_id: "c1", court_name: "Court 2", starts_at: "2099-10-01T09:00:00Z", ends_at: "2099-10-01T09:30:00Z",
  status: "booked", charged_minutes: 100, checked_in_at: null, cancelled_at: null,
  booked_by: { user_id: MEMBER_ID, name: "Valerie Visser", is_self: true },
};
function memberRoutes(): ApiRoute[] {
  return [
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/doors", body: { day_started_at: "2026-09-23T00:00:00+02:00", timezone: "Africa/Johannesburg", shut_all_active: false, doors: [] } },
    {
      path: MEMBER,
      body: {
        user_id: MEMBER_ID, membership_id: "cccccccc-0000-4000-8000-00000000000c", full_name: "Valerie Visser",
        email: "valerie@example.com", membership_number: "VIS-1", status: "Active", account_status: "Active", email_verified: true,
        created_at: "2026-03-01T08:00:00Z", last_login_at: null, photo_url: null, is_admin: false, admin_source: null,
        groups: [], balance_minutes: 433, held_minutes: 33, held_until: "2099-10-03T09:30:00Z", passkey_count: 0,
        fingerprints: { count: 0, enrolments: [] }, next_bookings: [BOOKING], counts_30d: { bookings: 0, no_shows: 0, sessions_played: 0 },
      },
    },
    { path: `${MEMBER}/bookings`, body: { when: "upcoming", items: [BOOKING], next_cursor: null } },
    { path: "/api/v1/bookings/b1", body: { organiser: { user_id: MEMBER_ID, name: "Valerie Visser", photo_url: null }, players: [] } },
    {
      path: `${MEMBER}/trace`,
      body: {
        member: { user_id: MEMBER_ID, name: "Valerie Visser", membership_number: "VIS-1" },
        club_day: "2026-09-30", range: { from: "2026-09-30T00:00:00+02:00", to: "2026-10-01T00:00:00+02:00" },
        timezone: "Africa/Johannesburg",
        retention: { audit_days: 730, door_days: 90, door_horizon: "2026-07-02", door_rows_may_be_incomplete: false },
        events: [{
          at: "2026-09-30T14:17:00Z", strand: "booking", kind: "booking.made", headline: "Booked Court 2 for 11:00",
          actor: { user_id: MEMBER_ID, name: "Valerie Visser", kind: "member", is_self: true },
          subject: { user_id: MEMBER_ID, name: "Valerie Visser" },
        }],
        total: 1,
      },
    },
  ];
}

test.describe("the member page", () => {
  test("V-4: at 320 the Bookings card's actions stay inside the card and the charge is one line", async ({ page }) => {
    await open(page, `/admin/members/${MEMBER_ID}/bookings`, memberRoutes(), { width: 320 });
    const card = page.locator("li[data-booking-id=b1]");
    const cancel = card.getByRole("button", { name: /^Cancel/ });
    await expect(cancel).toBeVisible(ARRIVES);
    const [cardBox, cancelBox] = [await card.boundingBox(), await cancel.boundingBox()];
    expect(cancelBox!.x + cancelBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
    const charge = card.getByText("1 hour 40 minutes");
    const lineHeight = await charge.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    expect((await charge.boundingBox())!.height).toBeLessThanOrEqual(lineHeight + 1);
  });

  test("V-6: at 768 the balance is one line", async ({ page }) => {
    await open(page, `/admin/members/${MEMBER_ID}`, memberRoutes(), { width: 768 });
    const figure = page.getByTestId("member-balance");
    await expect(figure).toContainText("7 h 13 min", ARRIVES);
    const lineHeight = await figure.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    expect((await figure.boundingBox())!.height).toBeLessThanOrEqual(lineHeight + 1);
  });
});

test("V-7: at 320 the Night export note sits under its button, not squeezed beside it", async ({ page }) => {
  await open(page, `/admin/members/${MEMBER_ID}/night`, memberRoutes(), { width: 320 });
  const button = page.getByRole("button", { name: "Download CSV" });
  await expect(button).toBeVisible(ARRIVES);
  const note = page.getByText(/The download has the member's name in it/);
  const [b, n] = [await button.boundingBox(), await note.boundingBox()];
  expect(n!.y, "the note is beside the button").toBeGreaterThanOrEqual(b!.y + b!.height - 1);
});

const SETTINGS = {
  slice_minutes: 15, slice_price_credits: 8, advance_booking_days: 14, day_start_minute: 360, day_end_minute: 1320,
  penalty_pct: 30, grace_window_minutes: 5, penalty_window_minutes: 15, timezone: "Africa/Johannesburg",
  button_map: ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "off"],
  operating_hours: { mon: "06:00-22:00", sat: "07:00-20:00" },
  credits_per_zar_regular: 1.6, topup_block_zar: 100, topup_max_zar_per_member: 1000,
  member_per_day_max_minutes: 60, peak_hours: "16:00-19:00", peak_advance_hours_for_regular: 1,
  retention_years: 2, no_show_lookback_days: 7, walk_up_max_minutes: 90, heartbeat_seconds: 60,
  lcd_revert_seconds: 10, rapid_scan_window_seconds: 10, member_max_slots_per_day: 4, currency_symbol: "R",
};

test("V-13: at 1280 the save bar does not cover the error under the field being fixed", async ({ page }) => {
  await open(page, "/admin/settings", [{ path: "/api/v1/admin/settings/", body: SETTINGS }], { width: 1280 });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("searchbox", { name: "Search settings" }).fill("Slice length");
  const field = page.getByRole("spinbutton", { name: /Slice length/ });
  await field.fill("99999");
  const bar = page.getByRole("region", { name: "Unsaved settings" });
  await expect(bar).toContainText(/needs? fixing/);
  const error = field.locator("xpath=ancestor::*[@data-setting][1]").locator("[data-slot=field-error]");
  await expect(error).toBeVisible(ARRIVES);
  // Where the reviewer had it: the input just clear of the bar, its error under it. The window
  // is shortened until the bar's top sits 4px under the input — a resize, which is when the bar
  // re-measures and lifts what it covers.
  await page.waitForTimeout(300);
  const inputBottom = await field.evaluate((input) => input.getBoundingClientRect().bottom);
  const gap = (await bar.boundingBox())!.y - (inputBottom + 4);
  await page.setViewportSize({ width: 1280, height: Math.round(800 - gap) });
  await page.waitForTimeout(400);
  const barTop = (await bar.boundingBox())!.y;
  const errorBox = (await error.boundingBox())!;
  expect(errorBox.y + errorBox.height, "the error sits under the save bar").toBeLessThanOrEqual(barTop + 1);
});

// BA-01: Regenerate is gone (a reflash of every board); the key's control is "Rotate key" now.
test("V-5: at 1280 'Rotate key' is on one line", async ({ page }) => {
  await open(page, "/admin/monitoring/devices", [
    { path: "/api/v1/admin/devices/api-key", body: { api_key: "W6wWabcdefghQWpI", regenerated_at: "2026-09-29T17:05:00Z", key_id: "k1", rotation: null } },
    { path: "/api/v1/admin/devices", body: [] },
  ], { width: 1280 });
  const button = page.getByRole("button", { name: "Rotate key" });
  await expect(button).toBeVisible(ARRIVES);
  const lines = await button.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el.querySelector("[data-slot=button-label]") ?? el);
    return range.getClientRects().length;
  });
  expect(lines, "the label broke over lines").toBeLessThanOrEqual(1);
});
