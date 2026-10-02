import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes } from "./playersKit";

// A cold dev server compiles the admin frame on first ask, and the machine is shared.
test.describe.configure({ timeout: 90_000 });

/**
 * Review round 5, lane E1 — admin people and money, measured in Chromium: the member record's
 * Sign-in tab and booking lines at phone width and 200 % text (F5-3, F5-4), the tab strip's
 * focused tab clear of its edge fades (X5-9), 44px targets (X5-12), the compact phone cards
 * (§4.3), the Groups column only where somebody has a group (V-14), and how many times a cold
 * Members page reads the attention counts (P5).
 */

const MEMBER_ID = "bbbbbbbb-0000-4000-8000-00000000000b";
const BASE = `/api/v1/admin/members/${MEMBER_ID}`;
const LONG_EMAIL = "naledi.khumalo-vandermerwe.longaddress@members-of-the-crusaders-r5.review.test";
const LONG_NAME = "Wolfgang-Amadeus-Bartholomew Buitendach-Oosthuizen-Featherstonehaugh";

function partnerRow() {
  const start = new Date(Date.now() + 2 * 86_400_000);
  start.setUTCHours(16, 0, 0, 0);
  return {
    booking_id: "aaaaaaaa-0000-4000-8000-0000000000a1", court_id: "c1", court_name: "Court 4",
    starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 45 * 60_000).toISOString(),
    status: "booked", charged_minutes: 50, checked_in_at: null, cancelled_at: null,
    booked_by: { user_id: "x", name: LONG_NAME, is_self: false },
    role: "partner", organiser: { user_id: "x", name: LONG_NAME, is_self: false },
  };
}

function detail() {
  return {
    user_id: MEMBER_ID, membership_id: "cccccccc-0000-4000-8000-00000000000c",
    full_name: "Naledi Khumalo", email: LONG_EMAIL,
    membership_number: "CR-2026-0184", status: "Active", account_status: "Active", email_verified: true,
    created_at: "2026-03-01T08:00:00Z", last_login_at: "2026-09-22T17:30:00Z", photo_url: null,
    is_admin: false, admin_source: null, groups: [],
    balance_minutes: 120, passkey_count: 1, fingerprints: { count: 0, enrolments: [] },
    next_bookings: [partnerRow()], counts_30d: { bookings: 6, no_shows: 1, sessions_played: 5 },
  };
}

function member(i: number, status: string, groups: { id: string; name: string }[] = []) {
  return {
    user_id: `00000000-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`,
    membership_id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
    full_name: i === 0 ? "Bartholomew Fitzwilliam" : `Member ${i}`, email: `member.${i}@member-r5.review.test`,
    membership_number: `MEM-10${String(i).padStart(2, "0")}`, status, email_verified: true,
    balance_minutes: 1234.5, created_at: "2026-09-05T08:00:00Z", photo_url: null,
    is_admin: false, admin_source: null, groups,
  };
}

function routes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    ...memberShellRoutes({ admin: true }),
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/play/results/disputed/count", body: { count: 0 } },
    { path: "/api/v1/admin/members/", body: [member(1, "Active"), member(2, "Active"), member(3, "Suspended")] },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    { path: BASE, body: detail() },
    { path: `${BASE}/play`, body: { sessions_attended: 0, minutes_this_month: 0, minutes_all_time: 0, current_streak_weeks: 0, matches_played: 0, matches_won: 0, matches_lost: 0, open_disputes: 0, badges_earned: 0 } },
    ...extra,
  ];
}

async function open(page: Page, path: string, width: number, bigText: boolean, extra: ApiRoute[] = []) {
  await page.setViewportSize({ width, height: 900 });
  await signIn(page);
  await serveApi(page, routes(extra));
  await page.goto(path);
  if (bigText) await page.addStyleTag({ content: "html { font-size: 32px; }" });
  await expect(page.locator("nav[data-primary-nav]")).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
}

/** Sideways scroll on the document or the app's scroller, and text laid out past the viewport. */
async function overflow(page: Page) {
  await expect(page.locator("#main-content .animate-pulse")).toHaveCount(0, { timeout: 30_000 });
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const main = document.getElementById("main-content");
    const scroll = Math.max(...[document.documentElement, main].filter(Boolean).map((el) => el!.scrollWidth - el!.clientWidth));
    const past: string[] = [];
    const walker = document.createTreeWalker(main ?? document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim() || n.parentElement?.closest(".sr-only, [aria-hidden='true']")) continue;
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

test.describe("R5 F5-3 — the Sign-in tab with a long verified address", () => {
  for (const [width, big] of [[390, false], [320, true], [390, true]] as const) {
    test(`nothing scrolls sideways at ${width}${big ? ", 200%" : ""}`, async ({ page }) => {
      await open(page, `/admin/members/${MEMBER_ID}/access`, width, big);
      await expect(page.getByText("members-of-the-crusaders-r5.review.test", { exact: false }).last()).toBeVisible({ timeout: 30_000 });
      const o = await overflow(page);
      expect(o.past, "text past the right edge").toEqual([]);
      expect(o.scroll, "sideways scroll").toBeLessThanOrEqual(1);
    });
  }
});

test.describe("R5 F5-4 — a partner's booking line names a long organiser", () => {
  test("wraps inside the card at 390 with 200 % text", async ({ page }) => {
    await open(page, `/admin/members/${MEMBER_ID}`, 390, true);
    await expect(page.locator("[data-booking-id]").first()).toBeVisible({ timeout: 30_000 });
    const o = await overflow(page);
    expect(o.past, "text past the right edge").toEqual([]);
    expect(o.scroll, "sideways scroll").toBeLessThanOrEqual(1);
    const inside = await page.locator("[data-booking-id]").first().evaluate((li) => li.scrollWidth <= li.clientWidth + 1);
    expect(inside, "the line holds its own words").toBe(true);
  });
});

test.describe("R5 X5-9 — the member tabs at 390", () => {
  test("every focused tab sits clear of the strip's edge fades", async ({ page }) => {
    await open(page, `/admin/members/${MEMBER_ID}`, 390, false);
    const tabs = page.locator("nav[aria-label] a[href^='/admin/members/']");
    await expect(tabs.first()).toBeVisible({ timeout: 30_000 });
    const count = await tabs.count();
    for (let i = 0; i < count; i += 1) {
      await tabs.nth(i).focus();
      const clear = await tabs.nth(i).evaluate((tab) => {
        const box = tab.closest("nav")!.parentElement!;
        const b = box.getBoundingClientRect();
        const t = tab.getBoundingClientRect();
        const fade = 24;
        const atStart = box.scrollLeft <= 0;
        const atEnd = box.scrollLeft + box.clientWidth >= box.scrollWidth - 1;
        return {
          left: atStart || t.left >= b.left + fade - 0.5,
          right: atEnd || t.right <= b.right - fade + 0.5,
          label: tab.textContent,
        };
      });
      expect(clear.left && clear.right, `"${clear.label}" sits under an edge fade`).toBe(true);
    }
  });
});

test.describe("R5 §4.3 / X5-12 — the members list on a phone", () => {
  test("an active member's card is about 72px, its name and ⋯ 44px targets, Sell package in the ⋯", async ({ page }) => {
    await open(page, "/admin/members", 390, false);
    const card = page.locator("tr[data-member-row]").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    const heights = await page.locator("tr[data-member-row]").evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect().height));
    for (const h of heights) expect(h, "a compact card").toBeLessThanOrEqual(80);
    const name = await card.locator("a").first().boundingBox();
    expect(name!.height, "the name link's target").toBeGreaterThanOrEqual(44);
    const more = card.locator("[data-member-menu]");
    const box = await more.boundingBox();
    expect(Math.min(box!.width, box!.height), "the ⋯ target").toBeGreaterThanOrEqual(44);
    await expect(card.getByRole("button", { name: "Sell package" })).toBeHidden();
    await more.click();
    await expect(page.getByRole("menuitem", { name: "Sell package" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Adjust minutes" })).toBeVisible();
    expect((await overflow(page)).scroll).toBeLessThanOrEqual(1);
  });
});

test.describe("R5 V-14 — the members table at 1280", () => {
  test("draws no Groups column when nobody on the page is in a group", async ({ page }) => {
    await open(page, "/admin/members", 1280, false, [
      { path: "/api/v1/admin/member-groups", body: { groups: [{ id: "g1", name: "League" }] } },
      { path: "/api/v1/admin/member-groups/g1/members", body: { members: [], cursor: null } },
    ]);
    await expect(page.locator("tr[data-member-row]").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("thead th", { hasText: "Groups" })).toHaveCount(0);
  });
});

test.describe("R5 P5 — the attention counts on a cold Members page", () => {
  test("are read once, and not again when the list lands", async ({ page }) => {
    let pendingReads = 0;
    page.on("request", (r) => { if (r.url().includes("status=PendingApproval")) pendingReads += 1; });
    await open(page, "/admin/members", 1280, false);
    await expect(page.locator("tr[data-member-row]").first()).toBeVisible({ timeout: 30_000 });
    // Long enough for a re-read the list's landing would have set off.
    await page.waitForTimeout(1_500);
    expect(pendingReads).toBe(1);
  });
});

test.describe("R5 P5 — a deep link to one member", () => {
  test("reads no group's member list and no enrolments for the list beside it", async ({ page }) => {
    const extra: string[] = [];
    page.on("request", (r) => {
      const url = r.url();
      if (url.includes("/admin/member-groups") || url.includes("/admin/biometric/enrollments")) extra.push(new URL(url).pathname);
    });
    await open(page, `/admin/members/${MEMBER_ID}`, 1440, false);
    await expect(page.getByTestId("member-balance")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_000);
    expect(extra).toEqual([]);
  });
});

test.describe("R5 V-6 (lane A's ask) — the member's Wallet tab", () => {
  test("frames the ledger without making a scroll box of its own, so the heads can stick to the page", async ({ page }) => {
    const row = {
      id: "l1", at: "2026-09-30T08:00:00Z", from: "Club", to: "Naledi Khumalo", amountMinutes: 50, signedAmountMinutes: 50,
      type: "AdminTopUp", comment: "Desk", subjectUserId: MEMBER_ID, subjectName: "Naledi Khumalo",
      actorUserId: "a", actorName: "Admin", relatedBookingId: null,
    };
    await open(page, `/admin/members/${MEMBER_ID}/wallet`, 1280, false, [{ path: "/api/v1/admin/ledger", body: [row] }]);
    const table = page.locator("#main-content table").first();
    await expect(table).toBeVisible({ timeout: 30_000 });
    const frame = await table.evaluate((t) => {
      const el = t.closest(".rounded-xl.border") as HTMLElement | null;
      return el ? getComputedStyle(el).overflowX : "none";
    });
    expect(frame).toBe("clip");
  });
});
