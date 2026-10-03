import { type Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { BOOKING, detailFixture, memberShellRoutes, seat } from "./playersKit";

/**
 * Review round 9, lane FC9 — the member's screens at 200 % text on a phone.
 *
 * <p>
 * L9-6: a seat chip's status pill broke "Orga/niser" — the avatar kept its row beside a column
 * too narrow for one word. The words are read as TEXT ranges (gotchas-frontend-layout), not boxes.
 * </p>
 */

async function open(page: Page, path: string, width: number, routes: ApiRoute[], bigText = true) {
  await page.setViewportSize({ width, height: 844 });
  await signIn(page);
  await serveApi(page, [...routes, ...memberShellRoutes({ unread: 0 })]);
  await page.goto(path);
  if (bigText) await page.addStyleTag({ content: "html { font-size: 32px; }" });
}

/** Every word under `selector` whose rects sit on two lines (a hyphen, dash, slash or middot may break). */
export async function brokenWords(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).first().evaluate((root) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const host = node.parentElement;
      if (!host || host.closest(".sr-only") || host.getClientRects().length === 0) continue;
      for (const m of (node.textContent ?? "").matchAll(/[^\s\-–—/·]+/g)) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0);
        if (new Set(rects.map((r) => Math.round(r.top))).size > 1) out.push(`split: ${m[0]}`);
        if (rects.some((r) => r.right > window.innerWidth + 1 || r.left < -1)) out.push(`off-screen: ${m[0]}`);
      }
    }
    return out;
  });
}

const DETAIL: ApiRoute[] = [{ path: `/api/v1/bookings/${BOOKING}`, body: detailFixture({
  players: [
    seat({ name: "Nomsa Khumalo-Mthembu" }),
    seat({ participant_id: "p0000000-0000-0000-0000-000000000003", seat: 3, team: "B", kind: "member", user_id: "u3",
      name: "Alexandria Naidoo", status: "invited", unpaid_minutes: 25 }),
  ],
}) }];

for (const width of [320, 390] as const) {
  test(`L9-6 — seat chips keep every word whole at ${width} px, 200 % text`, async ({ page }) => {
    await open(page, `/bookings/${BOOKING}`, width, DETAIL);
    const chips = page.locator("li[data-seat]").first();
    await expect(chips).toBeVisible();
    await chips.scrollIntoViewIfNeeded();
    for (const li of await page.locator("li[data-seat][data-status]").all()) {
      expect(await brokenWords(page, `li[data-seat="${await li.getAttribute("data-seat")}"]`)).toEqual([]);
    }
    await page.screenshot({ path: test.info().outputPath(`chips-${width}.png`) });
  });
}

test("L9-6 — at normal text the avatar still stands beside the name", async ({ page }) => {
  await open(page, `/bookings/${BOOKING}`, 390, DETAIL, false);
  const chip = page.locator("li[data-seat='1']");
  await expect(chip).toBeVisible();
  const avatar = await chip.locator("[data-slot='avatar']").first().evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  const name = await chip.getByText("Nomsa", { exact: false }).first().evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  expect(name.left, "the name is beside the photo").toBeGreaterThan(avatar.right);
  const free = page.locator("li[data-free]").first();
  const ring = await free.locator("span[aria-hidden='true']").first().evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  const words = await free.getByText("Free seat").evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  expect(words.left, "a free seat's words are beside its ring").toBeGreaterThan(ring.right);
});

test("L9-6 — at 320 px, 200 % text, a free seat's words stand under its ring, whole", async ({ page }) => {
  await open(page, `/bookings/${BOOKING}`, 320, DETAIL);
  const free = page.locator("li[data-free]").first();
  await expect(free).toBeVisible();
  const ring = await free.locator("span[aria-hidden='true']").first().evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  const words = await free.getByText("Free seat").evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
  expect(words.top, "under the ring").toBeGreaterThanOrEqual(ring.bottom);
  expect(await brokenWords(page, "li[data-free]")).toEqual([]);
});

/* ───────────── J8-3 + X8-1 rest — booking FOR a member at 200 % text on a phone ───────────── */

const COURTS = ["a", "b", "c", "d"].map((x, i) => ({ id: `aaaaaaaa-0000-4000-8000-00000000000${x}`, courtNumber: i + 1, name: `Court ${i + 1}` }));
const inDays = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DAY = inDays(2);
const MEMBER = "99999999-0000-4000-8000-000000000001";
const FIRST_BOOK = '[role="grid"] button[aria-label^="Book "]';

function bookForRoutes(): ApiRoute[] {
  return [
    { path: "/api/v1/schedule", body: {
      date: DAY, timezone: "UTC", sliceMinutes: 15, dayStartMinute: 8 * 60, dayEndMinute: 20 * 60,
      advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: COURTS, slots: [],
    } },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: "UTC", items: [] } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: "UTC", items: [] } },
    { path: `/api/v1/admin/members/${MEMBER}/booking-rules`, body: { day: DAY, groups: [], allowed_windows: null, empty_window_groups: null } },
    { path: `/api/v1/admin/members/${MEMBER}`, body: { full_name: "Naledi Dlamini", balance_minutes: 240 } },
  ];
}

/** The bar's and focus's place, against `<main>`'s visible band (under the app bar, above the tab bar). */
const barAndFocus = (page: Page) => page.evaluate(() => {
  const main = document.querySelector("main")!.getBoundingClientRect();
  const bar = document.querySelector("[data-booking-for]")!.getBoundingClientRect();
  const el = document.activeElement as HTMLElement | null;
  const f = el?.getBoundingClientRect();
  const bottom = Math.min(main.bottom, window.innerHeight);
  return {
    bar: { top: Math.round(bar.top), bottom: Math.round(bar.bottom) }, main: { top: Math.round(main.top), bottom: Math.round(bottom) },
    focus: el === document.body ? "BODY" : `${el?.tagName}:${Math.round(f?.top ?? 0)}`,
    focusVisible: el === document.body || Boolean(f && f.bottom > main.top && f.top >= main.top - 1 && f.top < bottom),
    scrollTop: document.querySelector("main")!.scrollTop,
  };
});

for (const [width, height] of [[320, 640], [390, 844]] as const) {
  for (const arrive of ["direct", "in-app"] as const) {
    test(`J8-3/X8-1 — ${width} px, 200 % text, ${arrive}: the "Booking for" bar opens in view and focus is never off-screen`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop", "widths are set per test");
      await page.setViewportSize({ width, height });
      await signIn(page);
      await serveApi(page, [...bookForRoutes(), ...memberShellRoutes({ admin: true })]);
      await page.addInitScript(() => {
        const add = () => { const s = document.createElement("style"); s.textContent = "html { font-size: 32px; }"; document.documentElement.appendChild(s); };
        if (document.documentElement) add(); else addEventListener("DOMContentLoaded", add);
      });
      const target = `/bookings?as=${MEMBER}&date=${DAY}`;
      if (arrive === "direct") await page.goto(target);
      else {
        await page.goto("/bookings/invites");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        // An in-app navigation, as the member page's "Book for member" link makes: the announcer moves focus.
        await page.evaluate((to) => { history.pushState({}, "", to); dispatchEvent(new PopStateEvent("popstate")); }, target);
      }
      await page.waitForSelector(FIRST_BOOK);
      await expect(page.locator("[data-booking-for]")).toContainText("Naledi");
      await page.waitForTimeout(1500);
      const m = await barAndFocus(page);
      expect(m.bar.top, `bar ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(m.main.top - 1);
      expect(m.bar.top, `bar starts on the screen ${JSON.stringify(m)}`).toBeLessThan(m.main.bottom);
      expect(m.focusVisible, `focus ${JSON.stringify(m)}`).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`bookfor-${width}-${arrive}.png`) });
    });
  }
}

/* The review's own path: the admin frame's member page → "Book for member" (an in-app navigation out of the admin frame). */
const ADMIN_MEMBER = "bbbbbbbb-0000-4000-8000-00000000000b";
function fromMemberPageRoutes(): ApiRoute[] {
  const base = `/api/v1/admin/members/${ADMIN_MEMBER}`;
  return [
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: { critical: 0, error: 0, warning: 0 } } },
    { path: "/api/v1/admin/members", body: [] },
    { path: base, body: {
      user_id: ADMIN_MEMBER, membership_id: "cccccccc-0000-4000-8000-00000000000c", full_name: "Naledi Khumalo-Van der Merwe",
      email: "naledi@member.test", membership_number: "CR-2026-0184", status: "Active", account_status: "Active", email_verified: true,
      created_at: "2026-03-01T08:00:00Z", last_login_at: "2026-09-22T17:30:00Z", photo_url: null, is_admin: false, groups: [],
      balance_minutes: 240, passkey_count: 0, fingerprints: { count: 0, enrolments: [] }, next_bookings: [],
      counts_30d: { bookings: 0, no_shows: 0, sessions_played: 0 },
    } },
    { path: `${base}/play`, body: { sessions_attended: 0, minutes_this_month: 0, minutes_all_time: 0, current_streak_weeks: 0, matches_played: 0, matches_won: 0, matches_lost: 0, open_disputes: 0, badges_earned: 0 } },
    { path: `${base}/booking-rules`, body: { day: DAY, groups: [], allowed_windows: null, empty_window_groups: null } },
    ...bookForRoutes().filter((r) => !r.path.startsWith("/api/v1/admin/members/")),
  ];
}

for (const [width, height] of [[320, 640], [390, 844]] as const) {
  test(`J8-3/X8-1 — ${width} px, 200 % text, from the member page's "Book for member": bar in view, focus never off-screen`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "widths are set per test");
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height });
    await signIn(page);
    await serveApi(page, [...fromMemberPageRoutes(), ...memberShellRoutes({ admin: true })]);
    await page.goto(`/admin/members/${ADMIN_MEMBER}`);
    await page.addStyleTag({ content: "html { font-size: 32px; }" });
    const book = page.locator("a[href^='/bookings?']").filter({ hasText: "Book for member" }).first();
    await expect(book).toBeVisible({ timeout: 30_000 });
    await book.click();
    await page.waitForSelector(FIRST_BOOK, { timeout: 30_000 });
    await expect(page.locator("[data-booking-for]")).toContainText("Naledi");
    for (const wait of [300, 1500, 5000]) {
      await page.waitForTimeout(wait);
      const m = await barAndFocus(page);
      expect(m.bar.top, `bar after ${wait} ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(m.main.top - 1);
      expect(m.bar.top, `bar on screen after ${wait} ${JSON.stringify(m)}`).toBeLessThan(m.main.bottom);
      expect(m.focusVisible, `focus after ${wait} ${JSON.stringify(m)}`).toBe(true);
    }
    await page.screenshot({ path: test.info().outputPath(`bookfor-member-page-${width}.png`) });
  });
}
