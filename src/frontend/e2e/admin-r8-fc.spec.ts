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
