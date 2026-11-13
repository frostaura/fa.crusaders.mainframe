import type { Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute, singleTap } from "./fixtures";
import { BOOKING, CLUB_ZONE, ME, detailFixture, inviteFixture, memberShellRoutes, tomorrowAt } from "./playersKit";

// A cold dev server compiles the admin frame on first ask, and the machine is shared.
test.describe.configure({ timeout: 120_000 });

/**
 * Review round 16, lane FE16s — layout, measured in Chromium.
 *
 * <ul>
 *   <li><b>L16-1</b>: a focus ring inside a box that clips or scrolls is drawn INSIDE its control —
 *       the wallet's ledger card (`overflow-clip`), DataTable's frame, the Bookings rail's strip
 *       and the grid's scroller cut the ring of whatever sat at their edge.</li>
 *   <li><b>L16-2</b>: /wallet/buy at 320 / 200 %, a package picked: the pay bar is not a third of the screen.</li>
 *   <li><b>L16-3</b>: a loading skeleton never pushes a 320 / 200 % phone sideways.</li>
 *   <li><b>L16-4</b>: a sheet's slot row stays inside its list at 320 / 200 %.</li>
 *   <li><b>L16-5</b>: a game card in the rail's strip is never wider than the rail.</li>
 * </ul>
 */

const ARRIVES = { timeout: 45_000 };
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** A member's ledger, long enough to scroll. */
function ledger(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const signed = i % 3 === 0 ? 200 + i : -(48 + i);
    return {
      id: `l${String(i).padStart(3, "0")}`, at: ago(60 * (i + 1)),
      from: signed >= 0 ? "Club treasury" : "Nomsa Khumalo", to: signed >= 0 ? "Nomsa Khumalo" : "Club treasury",
      amountMinutes: Math.abs(signed), signedAmountMinutes: signed, type: signed >= 0 ? "AdminTopUp" : "BookingCharge",
      comment: signed >= 0 ? "Desk top-up" : "Court 3 · 18:00–19:30",
      subjectUserId: ME, subjectName: "Nomsa Khumalo", actorUserId: ME, actorName: "Nomsa Khumalo", relatedBookingId: null,
    };
  });
}

const DAY = (i: number) => ({
  date: `2026-09-${String(i + 1).padStart(2, "0")}`, top_ups_minutes: 600, booking_charges_minutes: 540, refunds_minutes: -45,
  penalties_minutes: 13, adjustments_minutes: 0, reversals_minutes: -60, share_transfers_minutes: 0, net_movement_minutes: -122,
  bookings: 12, no_shows: 2, spent_minutes: 40, attended: 1, minutes_on_court: 60, balance_minutes: 500,
});

function game(i: number, overrides: Record<string, unknown> = {}) {
  return {
    booking_id: `b0000000-0000-0000-0000-00000000010${i}`, court_name: `Court ${i + 1}`,
    starts_at: tomorrowAt(17 + i), ends_at: tomorrowAt(17 + i, 45), sold_ends_at: tomorrowAt(17 + i, 45), role: "organiser",
    status: "booked", players: [{ name: "Nomsa Khumalo", photo_url: null, status: "accepted" }],
    my_share_minutes: 45, needs_action: false, ...overrides,
  };
}

const COURTS = [1, 2, 3, 4].map((n) => ({ id: `c${n}`, courtNumber: n, name: `Court ${n}`, slicePriceCredits: 15 }));

function schedule(slots: unknown[] = []) {
  return {
    date: tomorrowAt(10).slice(0, 10), timezone: CLUB_ZONE, sliceMinutes: 15, dayStartMinute: 360, dayEndMinute: 1320,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 120, courts: COURTS, slots,
  };
}

const MEMBER_BASE = `/api/v1/admin/members/${ME}`;

/** `extra` first: on an equal path the first route wins, so a spec's own answer replaces the default. */
function routes(extra: ApiRoute[] = [], admin = false): ApiRoute[] {
  const entries = ledger(24);
  return [
    ...extra,
    ...memberShellRoutes({ admin, invites: [inviteFixture()], wallet: { entries, total_entries: entries.length, limit: 50 } }),
    { path: "/api/v1/me/preferences", body: {} },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: CLUB_ZONE, items: [game(0), game(1), game(2)] } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: CLUB_ZONE, items: [] } },
    { path: "/api/v1/schedule", body: schedule() },
    { path: `/api/v1/bookings/${BOOKING}`, body: detailFixture() },
    { path: "/api/v1/reports/me/wallet", body: { from: "2026-09-01", to: "2026-09-03", top_ups_minutes: 1600, spent_minutes: 400, refunds_minutes: 0,
      penalties_minutes: 0, adjustments_minutes: 0, reversals_minutes: 0, net_movement_minutes: 1200, penalty_count: 0, attended_bookings: 3, minutes_on_court: 180 } },
    { path: "/api/v1/reports/me/daily", body: [0, 1, 2, 3, 4, 5].map(DAY) },
    { path: "/api/v1/minutes/packages", body: { discount: null, open_checkouts: [], packages: [
      { id: "p-1", name: "1 hour", minutes: 60, price_zar: 120, list_price_zar: 120, discount_bps: null, group: null },
      { id: "p-5", name: "5 hours of evening squash", minutes: 300, price_zar: 550, list_price_zar: 550, discount_bps: null, group: null },
    ] } },
  ];
}

function adminRoutes(extra: ApiRoute[] = []): ApiRoute[] {
  return routes([
    { path: "/api/v1/whoami", body: { ...SESSION_ADMIN, user_id: ME } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/play/results/disputed/count", body: { count: 0 } },
    { path: "/api/v1/admin/members/", body: [] },
    { path: MEMBER_BASE, body: {
      user_id: ME, membership_id: "cccccccc-0000-4000-8000-00000000000c", full_name: "Nomsa Khumalo", email: "nomsa@club.review.test",
      membership_number: "P-1", status: "Active", account_status: "Active", email_verified: true, created_at: "2026-03-01T08:00:00Z",
      last_login_at: null, photo_url: null, is_admin: false, admin_source: null, groups: [], balance_minutes: 120, passkey_count: 1,
      fingerprints: { count: 0, enrolments: [] }, next_bookings: [], counts_30d: { bookings: 6, no_shows: 1, sessions_played: 5 },
    } },
    { path: `${MEMBER_BASE}/play`, body: { sessions_attended: 0, minutes_this_month: 0, minutes_all_time: 0, current_streak_weeks: 0,
      matches_played: 0, matches_won: 0, matches_lost: 0, open_disputes: 0, badges_earned: 0 } },
    { path: "/api/v1/admin/ledger/", body: ledger(24) },
    { path: "/api/v1/admin/reports/revenue", body: { from: "", to: "", gross_topups_zar: 2025, reversals_zar: 0, net_zar: 2025,
      gross_topups_minutes: 1800, reversals_minutes: 0, net_minutes: 1800, zar_per_minute_sold: 1.125 } },
    { path: "/api/v1/admin/reports/utilisation", body: { from: "", to: "", by_court: [{ court_id: "c-1", court_name: "Court 1", bookings: 4,
      booked_minutes: 180, sold_minutes: 180, kept_minutes: 135 }] } },
    { path: "/api/v1/admin/reports/no-shows", body: { from: "", to: "", total: 24, no_show: 2, no_show_pct: 8.3 } },
    { path: "/api/v1/admin/reports/daily", body: [0, 1, 2, 3, 4, 5].map(DAY) },
    { path: "/api/v1/admin/courts/", body: [] },
    ...extra,
  ], true);
}

async function open(page: Page, path: string, options: { width?: number; root?: number; admin?: boolean; hang?: RegExp } = {}) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: options.width ?? 1280, height: 800 });
  await signIn(page);
  await serveApi(page, options.admin ? adminRoutes() : routes());
  // Registered after `serveApi`, so it wins: the read answers late and its skeleton stays up.
  const hang = options.hang;
  if (hang) {
    await page.route((url) => hang.test(url.pathname), async (route) => {
      await new Promise((later) => setTimeout(later, 30_000));
      await route.fallback().catch(() => undefined);
    });
  }
  const root = options.root ?? 16;
  if (root !== 16) {
    await page.addInitScript((px) => {
      const big = () => { document.documentElement.style.fontSize = `${px}px`; };
      if (document.documentElement) big();
      document.addEventListener("DOMContentLoaded", big);
    }, root);
  }
  await page.goto(path);
  await expect(page.locator("nav[data-primary-nav]").first()).toBeAttached(ARRIVES);
}

type Cut = { name: string; by: number; box: string };

/**
 * The focused control's ring (outline width + offset) against every clipping ancestor's padding
 * box — only while the control itself is inside that box, so a row scrolled half out of a table is
 * not a ring cut. The reviewer's probe (R16 L16-1), kept.
 */
function focusedCut(page: Page): Promise<Cut | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    const ext = cs.outlineStyle === "none" ? 0 : parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset);
    const q = el.getBoundingClientRect();
    const name = `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40)}"`;
    if (ext <= 0) return { name, by: 0, box: "" };
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const z = a.getBoundingClientRect();
      const l = z.left + a.clientLeft, t = z.top + a.clientTop, rr = l + a.clientWidth, b = t + a.clientHeight;
      const inside = q.left >= l - 1 && q.right <= rr + 1 && q.top >= t - 1 && q.bottom <= b + 1;
      if (!inside) continue;
      const by = Math.max(l - (q.left - ext), t - (q.top - ext), (q.right + ext) - rr, (q.bottom + ext) - b);
      if (by > 0.5) return { name, by: Math.round(by * 10) / 10, box: `${a.tagName.toLowerCase()}.${String(a.className).split(" ").slice(0, 4).join(".")}` };
    }
    return { name, by: 0, box: "" };
  });
}

/**
 * Tabs through the page and measures each focused control's ring ({@link focusedCut}).
 */
async function ringCuts(page: Page, stops = 70): Promise<Cut[]> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const cuts: Cut[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press("Tab");
    const r = await focusedCut(page);
    if (!r || seen.has(r.name)) continue;
    seen.add(r.name);
    if (r.by > 0) cuts.push(r);
  }
  return cuts;
}

test.describe("L16-1 — a ring inside a clipping or scrolling box is not cut", () => {
  for (const [path, admin, anchor] of [
    ["/wallet", false, "table"],
    ["/wallet/activity", false, "table"],
    ["/bookings", false, "[role=grid]"],
    [`/admin/members/${ME}/wallet`, true, "table"],
    ["/admin/reports", true, "table"],
  ] as const) {
    for (const width of [390, 1280]) {
      test(`${path} at ${width}: no focused control's ring is clipped`, async ({ page }) => {
        await open(page, path, { width, admin });
        await expect(page.locator(anchor).first()).toBeVisible(ARRIVES);
        await page.waitForTimeout(400);
        // FE16s2: no exceptions left — the chart carousel and the admin rail are inset now.
        expect(await ringCuts(page)).toEqual([]);
      });
    }
  }
});

/** Three rows for the members table: its sort heads sit on the scroller's top edge. */
const MEMBERS = [0, 1, 2].map((i) => ({
  user_id: `00000000-0000-4000-8000-00000000070${i}`, membership_id: `00000000-0000-4000-8000-00000000071${i}`,
  full_name: ["Bea Nkosi", "Sipho Dlamini", "Anke de Wet"][i], email: `m${i}@r16.review.test`, membership_number: `MEM-70${i}`,
  status: "Active", email_verified: true, balance_minutes: 120 + i, created_at: "2026-09-01T08:00:00Z", photo_url: null,
  is_admin: false, admin_source: null, groups: [],
}));

/** Keyboard modality, then focus — so `:focus-visible` (the house ring) applies to a programmatic focus. */
async function keyFocus(page: Page, selector: string, index: number): Promise<Cut | null> {
  await page.keyboard.press("Shift");
  const focused = await page.locator(selector).nth(index).evaluate((el: HTMLElement) => {
    if (el.getClientRects().length === 0) return null; // not drawn at this width: no ring to cut
    el.focus({ preventScroll: true });
    // A roving group (Radix's radiogroup) hands its focus on to the checked item: measure that.
    return document.activeElement?.matches(":focus-visible") ?? false;
  });
  if (focused === null) return null;
  return focused ? focusedCut(page) : { name: `${selector} #${index}`, by: -1, box: "not focus-visible" };
}

/**
 * R16 FE16s2 — the clipping boxes that keep the OUTWARD ring and leave it room instead (a primary
 * button's fill is the ring's colour, so a ring drawn over its edge vanishes). Each is measured
 * here; `clipped-focus-scan.test.ts` names them in `MEASURED_UNCUT`, or passes them by their room.
 */
test.describe("L16-1 measured (FE16s2) — boxes that give the ring room", () => {
  // Tab stops only: a roving week parks its other days at -1.
  const FOCUSABLE = ":is(a[href], button:not([disabled]), input, select, [tabindex='0']):not([tabindex='-1'])";
  for (const [path, width, head] of [
    ["/wallet/activity", 1280, "[data-range-bar]"],
    ["/bookings", 390, "[data-day-strip]"],
  ] as const) {
    test(`<main>: ${path} at ${width}, ${head} stuck at the scroller's top edge — its controls' rings are whole`, async ({ page }) => {
      await open(page, path, { width });
      await expect(page.locator(head)).toBeVisible(ARRIVES);
      await page.waitForTimeout(400);
      await page.locator("main#main-content").evaluate((m) => { m.scrollTop = m.scrollHeight; });
      await expect(page.locator(head)).toHaveAttribute("data-sticks", /.*/, ARRIVES);
      const count = await page.locator(`${head} :is(${FOCUSABLE})`).count();
      expect(count, "controls in the stuck head").toBeGreaterThan(0);
      const cuts: Cut[] = [];
      for (let i = 0; i < count; i++) {
        const r = await keyFocus(page, `${head} :is(${FOCUSABLE})`, i);
        if (r && r.by !== 0) cuts.push(r);
      }
      expect(cuts).toEqual([]);
    });
  }

  test("dialog: the cancel sheet at 320 / 200 % — header and body rings are whole", async ({ page }) => {
    const slot = {
      courtId: "c2", courtNumber: 2, startsAtUtc: tomorrowAt(18), endsAtUtc: tomorrowAt(18, 45), bookingId: BOOKING, isMine: true,
      ownerUserId: ME, ownerFirstName: "Nomsa", ownerPhotoUrl: null, checkedIn: null, amountChargedMinutes: 45, status: "booked",
    };
    const quote = { bookingId: BOOKING, amountChargedMinutes: 45, refundMinutes: 45, penaltyMinutes: 0, penaltyPct: 30,
      penaltyWindowMinutes: 120, insidePenaltyWindow: false, checkedIn: false, alreadyStarted: false };
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 320, height: 640 });
    await signIn(page);
    await serveApi(page, routes([
      { path: "/api/v1/schedule", body: schedule([slot]) },
      { path: `/api/v1/bookings/${BOOKING}/cancellation-quote`, body: quote },
    ]));
    await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = "32px"; }));
    await page.goto(`/bookings?date=${tomorrowAt(10).slice(0, 10)}`);
    await singleTap(page);
    const cell = page.locator("[role=grid]").getByRole("button", { name: /Court 2 at 18:00/ }).first();
    await expect(cell).toBeVisible(ARRIVES);
    await cell.click();
    await expect(page.getByRole("dialog").locator("[data-slot=dialog-body]")).toBeVisible(ARRIVES);
    await page.waitForTimeout(300);
    expect(await ringCuts(page, 20)).toEqual([]);
  });

  test("dropdown: the account menu at 390 / 200 % — every row's ring is whole as the panel scrolls", async ({ page }) => {
    await open(page, "/wallet", { width: 390, root: 32 });
    const trigger = page.getByRole("button", { name: "Account menu" });
    await expect(trigger).toBeVisible(ARRIVES);
    await trigger.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible(ARRIVES);
    const rows = await menu.getByRole("menuitem").count();
    const cuts: Cut[] = [];
    for (let i = 0; i < rows + 1; i++) {
      const r = await focusedCut(page);
      if (r && r.by > 0) cuts.push(r);
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(50);
    }
    expect(cuts).toEqual([]);
  });

  for (const width of [390, 1280]) {
    test(`ScrollArea + table: /admin/members at ${width} — the sort heads' rings are whole`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 800 });
      await signIn(page);
      // First match wins: ahead of adminRoutes' own empty list.
      await serveApi(page, [{ path: "/api/v1/admin/members/", body: MEMBERS }, ...adminRoutes()]);
      await page.goto("/admin/members");
      await expect(page.locator("[data-member-row]").first()).toBeVisible(ARRIVES);
      await page.waitForTimeout(400);
      expect(await ringCuts(page, 60)).toEqual([]);
    });
  }

  test("split view: /bookings/invites at 1280 — the sticky list's rings are whole", async ({ page }) => {
    await open(page, "/bookings/invites", { width: 1280 });
    await page.waitForTimeout(600);
    expect(await ringCuts(page, 40)).toEqual([]);
  });
});

test("L16-2 — /wallet/buy at 320 / 200 %, a package picked: the pay bar stays under a third of the screen", async ({ page }) => {
  await open(page, "/wallet/buy", { width: 320, root: 32 });
  await page.getByRole("radio").first().click();
  const button = page.locator("[data-context-bar]").getByRole("button", { name: /Continue to PayFast/ });
  await expect(button).toBeEnabled(ARRIVES);
  const m = await button.evaluate((b) => {
    const bar = b.closest("[data-context-bar]")!.getBoundingClientRect();
    const lines = Math.round((b.querySelector("span") ?? b).getBoundingClientRect().height / parseFloat(getComputedStyle(b).lineHeight));
    return { bar: bar.height, vh: innerHeight, lines, sideways: document.documentElement.scrollWidth - innerWidth };
  });
  console.log(`L16-2 pay bar ${JSON.stringify(m)}`);
  expect(m.lines, "the verb's lines").toBeLessThanOrEqual(2);
  expect(m.bar, "the pay bar's height").toBeLessThan(m.vh / 3);
  expect(m.sideways).toBeLessThanOrEqual(1);
});

test.describe("L16-3 — a loading skeleton stays inside a 320 / 200 % phone", () => {
  for (const [path, admin, hang] of [
    [`/bookings/${BOOKING}`, false, new RegExp(`^/api/v1/bookings/${BOOKING}$`)],
    ["/profile", false, /^\/api\/v1\/me\/webauthn\/credentials$|^\/api\/v1\/me\/profile$/],
    ["/admin/courts", true, /^\/api\/v1\/admin\/courts\/?$/],
    ["/wallet", false, /^\/api\/v1\/reports\/me\/wallet$/],
    ["/bookings", false, /^\/api\/v1\/schedule$|^\/api\/v1\/me\/bookings\//],
  ] as const) {
    test(`${path} while it loads`, async ({ page }) => {
      await open(page, path, { width: 320, root: 32, admin, hang });
      await expect(page.locator("main [data-slot='skeleton']").first()).toBeVisible(ARRIVES);
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => {
        const main = document.getElementById("main-content") ?? document.querySelector("main")!;
        const past = [...document.querySelectorAll("main [data-slot='skeleton']")]
          .map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.right > document.documentElement.clientWidth + 1).length;
        return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: main.scrollWidth - main.clientWidth, past };
      });
      expect(m, "sideways while loading").toEqual({ doc: 0, main: 0, past: 0 });
    });
  }
});

test.describe("L16-4 — the cancel sheet's slot row stays inside its list at 320 / 200 %", () => {
  for (const [who, admin, mine, name] of [
    ["the club, a long-named member's booking", true, false, "Wolfeschlegelsteinhausenberger"],
    ["a member, their own", false, true, "Nomsa"],
  ] as const) {
    test(who, async ({ page }) => {
      const slot = {
        courtId: "c2", courtNumber: 2, startsAtUtc: tomorrowAt(18), endsAtUtc: tomorrowAt(18, 45), bookingId: BOOKING, isMine: mine,
        ownerUserId: mine ? ME : "99999999-9999-4999-8999-999999999999", ownerFirstName: name, ownerPhotoUrl: null, checkedIn: null,
        amountChargedMinutes: 45, status: "booked",
      };
      const extra: ApiRoute[] = [
        { path: "/api/v1/schedule", body: schedule([slot]) },
        { path: `/api/v1/bookings/${BOOKING}/cancellation-quote`, body: {
          bookingId: BOOKING, amountChargedMinutes: 45, refundMinutes: 45, penaltyMinutes: 0, penaltyPct: 30,
          penaltyWindowMinutes: 120, insidePenaltyWindow: false, checkedIn: false, alreadyStarted: false,
        } },
        { path: `/api/v1/admin/bookings/${BOOKING}/cancellation-quote`, body: {
          bookingId: BOOKING, amountChargedMinutes: 45, refundMinutes: 45, penaltyMinutes: 0, penaltyPct: 30,
          penaltyWindowMinutes: 120, insidePenaltyWindow: false, checkedIn: false, alreadyStarted: false,
        } },
      ];
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width: 320, height: 800 });
      await signIn(page);
      await serveApi(page, admin ? adminRoutes(extra) : routes(extra));
      await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = "32px"; }));
      await page.goto(`/bookings?date=${tomorrowAt(10).slice(0, 10)}`);
      await singleTap(page);
      const cell = page.locator("[role=grid]").getByRole("button", { name: /Court 2 at 18:00/ }).first();
      await expect(cell).toBeVisible(ARRIVES);
      await cell.click();
      const list = page.getByRole("dialog").locator("ul").first();
      await expect(list).toBeVisible(ARRIVES);
      await page.waitForTimeout(300);
      const over = await list.evaluate((ul) => {
        const box = ul.getBoundingClientRect();
        return { scroll: ul.scrollWidth - ul.clientWidth, past: [...ul.querySelectorAll("li *")].filter((e) => e.getBoundingClientRect().right > box.right + 1).length };
      });
      expect(over).toEqual({ scroll: 0, past: 0 });
    });
  }
});

// The rail and its sideways strip went (the ticker carries the games beside the grid); the cards
// now lie in the games lists under the grid. The rule is the same: no card is wider than its room.
test.describe("L16-5 — a card in the Bookings games lists is never wider than the page", () => {
  for (const [width, root] of [[320, 32], [390, 16], [390, 32]] as const) {
    test(`${width} / ${root * 100 / 16} %`, async ({ page }) => {
      await open(page, "/bookings", { width, root });
      const list = page.locator("[data-upcoming]");
      await expect(list.locator("li").first()).toBeVisible(ARRIVES);
      const m = await list.evaluate((s) => {
        const room = Math.min(s.getBoundingClientRect().width, document.documentElement.clientWidth);
        const items = [...s.querySelectorAll("li")].map((el) => Math.round(el.getBoundingClientRect().right - s.getBoundingClientRect().left));
        return { room: Math.round(room), widest: Math.max(...items) };
      });
      expect(m.widest, `widest card's reach vs the list's ${m.room}px`).toBeLessThanOrEqual(m.room);
    });
  }
});

/**
 * L16-3's sweep: every member and admin route at 320 / 200 % with every read but who-am-I held, so
 * each page sits on its loading state. It runs every time (R16 FE16s2: all 31 clean, the opt-in
 * `FE16S_SWEEP` switch gone).
 */
const SWEEP = ["/my-code", "/bookings", "/bookings/invites", `/bookings/${BOOKING}`, "/inbox", "/wallet", "/wallet/buy", "/wallet/activity",
  "/profile", "/profile/results", "/admin", "/admin/members", `/admin/members/${ME}`, `/admin/members/${ME}/wallet`,
  `/admin/members/${ME}/bookings`, `/admin/members/${ME}/doors`, `/admin/members/${ME}/night`, "/admin/groups", "/admin/packages",
  "/admin/results", "/admin/transactions", "/admin/reports", "/admin/monitoring", "/admin/monitoring/doors", "/admin/monitoring/devices",
  "/admin/monitoring/faults", "/admin/monitoring/changes", "/admin/schedules", "/admin/courts", "/admin/settings", "/admin/webhooks"];

test.describe("L16-3 sweep — every route's loading state at 320 / 200 %", () => {
  for (const path of SWEEP) {
    test(path, async ({ page }) => {
      await open(page, path, { width: 320, root: 32, admin: true, hang: /^\/api\/v1\/(?!whoami$|me\/profile$|wallet$|me\/notifications\/unread-count$|me\/invites$|me\/door$|me\/play\/celebrations$|admin\/monitoring\/summary$|admin\/play\/results\/disputed\/count$)/ });
      await page.waitForTimeout(1500);
      const m = await page.evaluate(() => {
        const main = document.getElementById("main-content") ?? document.querySelector("main")!;
        const past = [...document.querySelectorAll("main [data-slot='skeleton']")]
          .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
          .map((el) => `${el.parentElement?.className.slice(0, 50)} > ${el.className.slice(0, 40)}`);
        // Not only skeletons: whatever runs past the scroller's edge is named, so a failure says where.
        const edge = main.getBoundingClientRect().left + main.clientWidth + 1;
        const over = main.scrollWidth <= main.clientWidth ? [] : [...main.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > edge && el.getBoundingClientRect().width > 0)
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 90)}`).slice(0, 3);
        return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: main.scrollWidth - main.clientWidth, past, over };
      });
      expect(m, "sideways while loading").toEqual({ doc: 0, main: 0, past: [], over: [] });
    });
  }
});
