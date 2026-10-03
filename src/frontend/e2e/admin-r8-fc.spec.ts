import { type Locator, type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes } from "./playersKit";
import { sideways } from "./layoutKit";

// A cold dev server compiles the admin frame on first ask, and the machine is shared.
test.describe.configure({ timeout: 90_000 });

/**
 * Review round 8, lane FC (admin UI) — measured in Chromium against a mocked API: what jsdom cannot
 * see (wrapping at 200 % text, where a button's label paints, where focus lands after an inline
 * editor opens or closes).
 */

const USER = "00000000-0000-4000-8000-000000000801";

function member(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER, membership_id: "00000000-0000-4000-8000-000000000811", full_name: "Paul Partner",
    email: "paul@r8.review.test", membership_number: "MEM-801", status: "Active", email_verified: true,
    balance_minutes: 540, created_at: "2026-09-01T08:00:00Z", photo_url: null, is_admin: false, admin_source: null,
    groups: [], ...overrides,
  };
}

const memberDetail = (overrides: Record<string, unknown> = {}) => ({
  ...member(), account_status: "active", last_login_at: null, passkey_count: 0,
  fingerprints: { count: 0, enrolments: [] }, next_bookings: [], counts_30d: { bookings: 0, no_shows: 0, sessions_played: 0 },
  ...overrides,
});

function adminRoutes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    ...extra,
    ...memberShellRoutes({ admin: true }),
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/play/results/disputed/count", body: { count: 0 } },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    { path: "/api/v1/admin/member-groups", body: { groups: [] } },
    { path: "/api/v1/admin/ledger/", body: [] },
    { path: "/api/v1/admin/minutes/", body: { discount: null, packages: [] } },
    { path: "/api/v1/admin/members/", body: [member()] },
  ];
}

async function open(page: Page, path: string, routes: ApiRoute[], width = 1280, height = 900) {
  await page.setViewportSize({ width, height });
  await signIn(page);
  await serveApi(page, routes);
  await page.goto(path);
}

const BIG = "html { font-size: 32px; }";

async function big(page: Page) {
  await page.addStyleTag({ content: BIG });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
}

/**
 * Words cut across lines: every run of non-space characters under `el` whose own line boxes sit on
 * more than one line ("Cou/rt"). A break after a hyphen or a dash is a real break, so those end a word.
 * A word wider than `el`'s whole content box can only break, so it is not counted.
 */
function brokenWords(el: Locator): Promise<string[]> {
  return el.evaluate((root) => {
    const cs = getComputedStyle(root);
    const room = root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      if (node.parentElement?.closest(".sr-only")) continue;
      for (const m of text.matchAll(/[^\s \-–]+[-–]?/g)) {
        const range = document.createRange();
        range.setStart(node, m.index!);
        range.setEnd(node, m.index! + m[0].length);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0);
        const tops = new Set(rects.map((r) => Math.round(r.top)));
        if (tops.size > 1 && rects.reduce((sum, r) => sum + r.width, 0) <= room) out.push(m[0]);
      }
    }
    return out;
  });
}

/** A figure's number and its unit on two lines ("2 | min"): every "<n> <unit>" pair must share a line. */
function splitFigures(el: Locator): Promise<string[]> {
  return el.evaluate((root) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      if (node.parentElement?.closest(".sr-only")) continue;
      for (const m of text.matchAll(/\d+[\s ]+(?:d|h|min)\b/g)) {
        const range = document.createRange();
        range.setStart(node, m.index!);
        range.setEnd(node, m.index! + m[0].length);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        if (tops.size > 1) out.push(m[0]);
      }
    }
    return out;
  });
}

/** Where focus is, by a name a person would recognise; "<body>" when it fell off the page. */
const focused = (page: Page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return "<body>";
  return el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 60) ?? el.tagName;
});

/* ───────────────────────────── L8-1 a member's booking rows at 200 % text ───────────────────────────── */

const bookingRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  booking_id: id, court_id: "c-1", court_name: "Court 1", starts_at: "2026-10-05T08:00:00Z", ends_at: "2026-10-05T09:00:00Z",
  sold_ends_at: "2026-10-05T09:00:00Z", status: "booked", charged_minutes: 60, cost_minutes: 60, checked_in_at: null,
  cancelled_at: null, booked_by: { user_id: USER, name: "Paul Partner", is_self: true }, role: "organiser",
  organiser: { user_id: USER, name: "Paul Partner", is_self: true }, ...overrides,
});

test.describe("L8-1 — a member's booking row never squeezes its text to a few letters a line", () => {
  for (const width of [320, 390, 768, 1280]) {
    test(`Bookings tab at ${width} / 200 %`, async ({ page }) => {
      await open(page, `/admin/members/${USER}/bookings`, adminRoutes([
        { path: `/api/v1/admin/members/${USER}/bookings`, body: { when: "upcoming", next_cursor: null, items: [
          bookingRow("b-1"),
          bookingRow("b-2", { court_name: "Championship Court", role: "partner", cost_minutes: 30,
            organiser: { user_id: "u-9", name: "Thandiwe Mokoena", is_self: false } }),
        ] } },
        { path: `/api/v1/admin/members/${USER}`, body: memberDetail() },
      ]), width);
      const rows = page.locator("[data-booking-id]");
      await expect(rows.first()).toBeVisible({ timeout: 30_000 });
      await big(page);
      if (process.env.FC_SHOTS) await rows.first().screenshot({ path: `${process.env.FC_SHOTS}/l8-1-${width}.png` });
      for (let i = 0; i < 2; i++) {
        const row = rows.nth(i);
        expect(await brokenWords(row), `row ${i}: a word is cut across lines`).toEqual([]);
        expect(await splitFigures(row), `row ${i}: a figure splits from its unit`).toEqual([]);
      }
      expect(await sideways(page)).toBeLessThanOrEqual(1);
    });
  }
});

/* ───────────────────────────── L8-6 / L8-7 nowrap buttons and split totals at 320 / 200 % ───────────────────────────── */

/**
 * A label painted past its own button. Measured on the label layer, not the button's scrollWidth:
 * the hidden pending spinner overflows every button by a few px and is never seen (gotchas-frontend-layout).
 */
function labelSpills(button: Locator): Promise<boolean> {
  return button.evaluate((el) => {
    const label = el.querySelector("[data-slot='button-label']") ?? el;
    const own = el.getBoundingClientRect();
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest(".sr-only")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if ([...range.getClientRects()].some((r) => r.width > 0 && (r.right > own.right + 1 || r.left < own.left - 1))) return true;
    }
    return false;
  });
}

const ledgerRow = (id: string, signed: number) => ({
  id, at: "2026-01-15T10:00:00Z", from: "Club treasury", to: "Paul Partner", amountMinutes: Math.abs(signed),
  signedAmountMinutes: signed, type: "AdminTopUp", comment: null, subjectUserId: USER, subjectName: "Paul Partner",
  actorUserId: USER, actorName: "Paul Partner", relatedBookingId: null,
});

const doorRow = (overrides: Record<string, unknown> = {}) => ({
  at: "2026-09-22T16:02:00Z", delivered_at: null, time_uncertain: false, action: "gate.released", outcome: "released",
  reason: null, reason_text: "Opened — a live booking", offline: false, method: "qr", fingerprint: null,
  door: { id: "d1", name: "Front door", gate_key: "front", removed: false }, ...overrides,
});

const doorsPage = (items: unknown[]) => ({
  member: { user_id: USER, name: "Paul Partner" }, items, next_cursor: null, total: items.length,
  range: { from: "2026-09-16T00:00:00+02:00", to: "2026-09-23T10:00:00+02:00" }, timezone: "Africa/Johannesburg", retention_days: 90,
});

const groupRow = (id: string, name: string) => ({
  id, name, description: null, status: "active", sort_order: 0, is_system_default: false,
  caps: { max_slots_per_day: null, max_minutes_per_day: null, advance_booking_days: null },
  windows: [], member_count: 3, system_key: null, package_discount_bps: null, peak_priority: null,
});

test.describe("L8-6 — a button's label wraps inside the screen at 320 / 200 %", () => {
  test("Transactions: Show more movements", async ({ page }) => {
    await open(page, "/admin/ledger?from=2026-01-01&to=2026-01-31", adminRoutes([
      { path: "/api/v1/admin/ledger/", body: { items: [ledgerRow("1", 60)], next_cursor: "c-2",
        totals: { count: 2, in_minutes: 120, out_minutes: 0, net_minutes: 120 } } },
    ]), 320, 700);
    const more = page.getByRole("button", { name: "Show more movements" });
    await expect(more).toBeVisible({ timeout: 30_000 });
    await big(page);
    expect(await labelSpills(more)).toBe(false);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });

  test("Groups: Preview week", async ({ page }) => {
    await open(page, "/admin/groups", adminRoutes([
      { path: "/api/v1/admin/member-groups", body: { groups: [groupRow("g-1", "Social evenings")] } },
      { path: "/api/v1/admin/packages", body: { packages: [] } },
    ]), 320, 700);
    const preview = page.getByRole("button", { name: /Preview week/ }).first();
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await big(page);
    expect(await labelSpills(preview)).toBe(false);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });

  test("Door history: Download CSV", async ({ page }) => {
    await open(page, `/admin/members/${USER}/doors`, adminRoutes([
      { path: `/api/v1/admin/members/${USER}/doors`, body: doorsPage([doorRow()]) },
      { path: `/api/v1/admin/members/${USER}`, body: memberDetail() },
    ]), 320, 700);
    const csv = page.getByRole("button", { name: /Download CSV/ });
    await expect(csv).toBeVisible({ timeout: 30_000 });
    await big(page);
    expect(await labelSpills(csv)).toBe(false);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });
});

test.describe("L8-7 — the Transactions totals never split a number from its unit", () => {
  for (const width of [320, 390]) {
    test(`at ${width} / 200 %`, async ({ page }) => {
      const long = 18 * 1440 + 3 * 60 + 2;
      await open(page, "/admin/ledger?from=2026-01-01&to=2026-01-31", adminRoutes([
        { path: "/api/v1/admin/ledger/", body: { items: [ledgerRow("1", long)], next_cursor: null,
          totals: { count: 1, in_minutes: long, out_minutes: long, net_minutes: -long } } },
      ]), width, 700);
      const totals = page.locator("[data-ledger-total]");
      await expect(totals.nth(3)).toBeVisible({ timeout: 30_000 });
      await big(page);
      for (let i = 1; i < 4; i++) expect(await splitFigures(totals.nth(i)), `total ${i}`).toEqual([]);
    });
  }
});
