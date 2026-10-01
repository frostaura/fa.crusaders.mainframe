import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes } from "./playersKit";
import { CONSOLE_COPY } from "../src/lib/notificationsCopy";

// A cold dev server compiles the admin frame on first ask, and the machine is shared: room to do so.
test.describe.configure({ timeout: 90_000 });

/**
 * Review round 4, lane F3 — the admin console at 320 / 390 / 768 with 200 % text (the round's
 * 200 %-text rule), measured in a real browser: nothing scrolls sideways, no word breaks
 * mid-letter, and the console-wide count sits with the switcher's caret, not beside the name.
 */

const MEMBER_ID = "bbbbbbbb-0000-4000-8000-00000000000b";
const BASE = `/api/v1/admin/members/${MEMBER_ID}`;

function detail() {
  return {
    user_id: MEMBER_ID, membership_id: "cccccccc-0000-4000-8000-00000000000c",
    full_name: "Naledi Khumalo-Van der Merwe", email: "naledi.khumalo.longaddress@member-r4.review.test",
    membership_number: "CR-2026-0184", status: "Active", account_status: "Active", email_verified: true,
    created_at: "2026-03-01T08:00:00Z", last_login_at: "2026-09-22T17:30:00Z", photo_url: null,
    is_admin: true, admin_source: "granted", groups: [{ id: "g1", name: "League" }],
    balance_minutes: -1250.5, passkey_count: 1, fingerprints: { count: 0, enrolments: [] },
    next_bookings: [], counts_30d: { bookings: 6, no_shows: 1, sessions_played: 5 },
  };
}

function adminRoutes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: { critical: 14, error: 9, warning: 23 } } },
    { path: "/api/v1/admin/members", body: [] },
    ...memberShellRoutes({ unread: 3, admin: true }),
    { path: BASE, body: detail() },
    {
      path: `${BASE}/play`,
      body: {
        sessions_attended: 5, minutes_this_month: 225, minutes_all_time: 1800, current_streak_weeks: 3,
        matches_played: 4, matches_won: 3, matches_lost: 1, open_disputes: 0, badges_earned: 2,
      },
    },
    ...extra,
  ];
}

async function open(page: Page, path: string, width: number, bigText: boolean, extra: ApiRoute[] = []) {
  await page.setViewportSize({ width, height: 900 });
  await signIn(page);
  await serveApi(page, adminRoutes(extra));
  await page.goto(path);
  if (bigText) await page.addStyleTag({ content: "html { font-size: 32px; }" });
  await expect(page.locator("nav[data-primary-nav]")).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
}

/** Sideways scroll on the document and on the app's own scroller, and text laid out past the viewport. */
async function overflow(page: Page) {
  // Measured once everything has loaded: a route's own loading skeleton (the shell's, F4's) is
  // not what this lane is measuring.
  await expect(page.locator("#main-content .animate-pulse")).toHaveCount(0, { timeout: 30_000 });
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const main = document.getElementById("main-content");
    const scroll = Math.max(...[document.documentElement, main].filter(Boolean).map((el) => el!.scrollWidth - el!.clientWidth));
    const past: string[] = [];
    const walker = document.createTreeWalker(main ?? document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim() || n.parentElement?.closest(".sr-only, [aria-hidden='true']")) continue;
      // Text inside its own sideways scroller (the tab strip) is reachable, not clipped.
      let inScroller = false;
      for (let a = n.parentElement; a && a !== main; a = a.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(a).overflowX)) { inScroller = true; break; }
      }
      if (inScroller) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const right = Math.max(0, ...[...range.getClientRects()].filter((r) => r.width > 0).map((r) => r.right));
      if (right > vw + 1) past.push(`${n.textContent.trim().slice(0, 40)} @${Math.round(right)}/${vw}`);
    }
    return { scroll, past };
  });
}

/** Every word of the element's text, and how many line boxes each one was laid out on. */
async function wordLines(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((els) => els.flatMap((el) => {
    const out: { word: string; lines: number }[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      for (const m of (n.textContent ?? "").matchAll(/[A-Za-z]{3,}/g)) {
        const range = document.createRange();
        range.setStart(n, m.index!);
        range.setEnd(n, m.index! + m[0].length);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        out.push({ word: m[0], lines: tops.size });
      }
    }
    return out;
  }));
}

test.describe("R4 A4-8 / V4-8 / V-16 — the section switcher", () => {
  for (const [width, big] of [[320, true], [390, true], [390, false]] as const) {
    test(`keeps the name whole and the console's count by the caret (${width}${big ? ", 200%" : ""})`, async ({ page }) => {
      await open(page, "/admin/members", width, big);
      const bar = page.locator("[data-admin-section-bar] button").first();
      // A cold dev server compiles the admin chunk on first ask: allow it (the page says "Opening…").
      await expect(bar).toBeVisible({ timeout: 30_000 });
      for (const w of await wordLines(page, "[data-admin-section-bar] button")) {
        expect(w.lines, `"${w.word}" is broken across lines`).toBe(1);
      }
      const badge = page.locator("[data-admin-section-bar] [data-admin-badge='total']");
      await expect(badge).toBeVisible();
      // Not in the name's row: the count sits right of every word of the section's name.
      const nameRight = await bar.locator("span.text-base").evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return Math.max(...[...range.getClientRects()].map((r) => r.right));
      });
      const b = await badge.boundingBox();
      expect(b!.x, "the count starts after the name ends").toBeGreaterThan(nameRight);
      expect((await overflow(page)).scroll).toBeLessThanOrEqual(1);
    });
  }
});

test.describe("R4 V4-9 — a member's header at 200 % text", () => {
  for (const width of [320, 390, 768]) {
    test(`nothing scrolls sideways or runs off at ${width}`, async ({ page }) => {
      await open(page, `/admin/members/${MEMBER_ID}`, width, true);
      await expect(page.getByTestId("member-balance")).toBeVisible({ timeout: 30_000 });
      const o = await overflow(page);
      expect(o.past, "text past the right edge").toEqual([]);
      expect(o.scroll, "sideways scroll").toBeLessThanOrEqual(1);
      for (const w of await wordLines(page, "section[aria-label$='summary'] [data-slot='badge']")) {
        expect(w.lines, `badge word "${w.word}" is broken across lines`).toBe(1);
      }
      // "Book for member" grows with its words instead of spilling out of a fixed box.
      const book = page.locator("section[aria-label$='summary'] a[href^='/bookings']");
      const fits = await book.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1);
      expect(fits, "Book for member holds its own words").toBe(true);
    });
  }
});

test.describe("R4 X4-6 — the Overview's quick links at 200 % text", () => {
  test("keep every label word whole on a 390 phone", async ({ page }) => {
    await open(page, "/admin", 390, true);
    // R5 A5-6: on a phone the Console is folded behind one toggle (it repeats the section switcher).
    await page.getByRole("button", { name: CONSOLE_COPY.show }).click();
    await expect(page.locator("[data-quick-link]").first()).toBeVisible({ timeout: 30_000 });
    for (const w of await wordLines(page, "[data-quick-link] .font-semibold")) {
      expect(w.lines, `"${w.word}" is broken across lines`).toBe(1);
    }
    expect((await overflow(page)).scroll).toBeLessThanOrEqual(1);
  });
});

test.describe("R4 V-14 — the members table at 1280", () => {
  test("gives the member column the room the fixed columns left empty", async ({ page }) => {
    const member = {
      user_id: "dddddddd-0000-4000-8000-00000000000d", membership_id: "eeeeeeee-0000-4000-8000-00000000000e",
      full_name: "Evie Okafor", email: "eve+muo@member-r4.review.test", membership_number: "MR4-MUOIEQJH-EVE",
      status: "PendingApproval", email_verified: true, balance_minutes: 0, created_at: "2026-09-30T08:00:00Z",
      photo_url: null, is_admin: false, admin_source: null, groups: [],
    };
    await open(page, "/admin/members", 1280, false, [{ path: "/api/v1/admin/members/", body: [member] }]);
    const address = page.locator("tbody p", { hasText: "member-r4.review.test" }).first();
    await expect(address).toBeVisible({ timeout: 30_000 });
    // Was 222px beside an 18rem actions column holding Top up and ⋯ (reviewer, 1280).
    const memberColumn = await page.locator("thead th").first().evaluate((th) => th.getBoundingClientRect().width);
    expect(memberColumn).toBeGreaterThanOrEqual(280);
    const lines = await address.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
    });
    expect(lines, "a review-length address on one line").toBe(1);
    const approve = page.getByRole("button", { name: /^Approve/ }).first();
    const reject = page.getByRole("button", { name: /^Reject/ }).first();
    const [a, r] = [await approve.boundingBox(), await reject.boundingBox()];
    expect(Math.abs(a!.y - r!.y), "Approve and Reject side by side").toBeLessThan(2);
  });
});

test.describe("R4 V-13 — the save bar and a field reached by Tab", () => {
  test("lifts the field's complaint clear of the bar when Tab lands on it at the bottom edge", async ({ page }) => {
    const settings = {
      slice_minutes: 15, slice_price_credits: 8, advance_booking_days: 14, day_start_minute: 360, day_end_minute: 1320,
      penalty_pct: 30, grace_window_minutes: 5, penalty_window_minutes: 15, timezone: "Africa/Johannesburg",
      button_map: ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "off"],
      operating_hours: { mon: "06:00-22:00" }, credits_per_zar_regular: 1.6, topup_block_zar: 100,
      topup_max_zar_per_member: 1000, member_per_day_max_minutes: 60, peak_hours: "16:00-19:00",
      peak_advance_hours_for_regular: 1, retention_years: 2, no_show_lookback_days: 7, currency_symbol: "R",
    };
    await open(page, "/admin/settings", 1280, false, [{ path: "/api/v1/admin/settings/", body: settings }]);
    await page.getByRole("searchbox", { name: "Search settings" }).fill("Top-up");
    const field = page.getByRole("spinbutton", { name: /Top-up block/ });
    await expect(field).toBeVisible({ timeout: 30_000 });
    await field.fill("0");
    await page.keyboard.press("Tab");
    const bar = page.getByRole("region", { name: "Unsaved settings" });
    await expect(bar).toBeVisible();
    const error = field.locator("xpath=ancestor::*[@data-setting][1]").locator("[data-slot=field-error]");
    await expect(error).toBeVisible();
    // Put the field at the bottom edge, under the bar, then come back to it with Shift+Tab: the
    // browser scrolls the FIELD clear (scroll-padding); its complaint must come with it.
    const barTop = (await bar.boundingBox())!.y;
    const fieldBottom = await field.evaluate((el) => el.getBoundingClientRect().bottom);
    await page.setViewportSize({ width: 1280, height: Math.max(420, Math.round(900 - (barTop - fieldBottom) - 20)) });
    await page.waitForTimeout(400);
    await page.keyboard.press("Shift+Tab");
    await expect(field).toBeFocused();
    await page.waitForTimeout(400);
    const top = (await bar.boundingBox())!.y;
    const box = (await error.boundingBox())!;
    expect(box.y + box.height, "the complaint sits under the save bar").toBeLessThanOrEqual(top + 1);
  });
});
