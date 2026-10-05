import type { Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
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
 * Clipping boxes in files outside this lane (R16 FE16s), whose cuts this spec measured and reported
 * to their owner rather than fixed: the wallet's chart carousel (`components/Carousel.tsx`) and the
 * admin rail (`components/admin/AdminRail.tsx`). `clipped-focus-scan.test.ts` holds them in its
 * ratchet; delete an entry here when its box is fixed.
 */
const OTHER_LANES = ["div.no-scrollbar.flex.snap-x", "div.sticky.overflow-y-auto.overscroll-contain"];

/**
 * Tabs through the page and measures each focused control's ring (outline width + offset) against
 * every clipping ancestor's padding box — only while the control itself is inside that box, so a
 * row scrolled half out of a table is not a ring cut. The reviewer's probe (R16 L16-1), kept.
 */
async function ringCuts(page: Page, stops = 70): Promise<Cut[]> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const cuts: Cut[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
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
        // OTHER_LANES: boxes in files outside this lane, reported and held by the guard's ratchet.
        const cuts = (await ringCuts(page)).filter((c) => !OTHER_LANES.some((box) => c.box.startsWith(box)));
        expect(cuts).toEqual([]);
      });
    }
  }
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

test.describe("L16-5 — a card in the Bookings rail's strip is never wider than the rail", () => {
  for (const [width, root] of [[320, 32], [390, 16], [390, 32]] as const) {
    test(`${width} / ${root * 100 / 16} %`, async ({ page }) => {
      await open(page, "/bookings", { width, root });
      const strip = page.locator("[data-rail-strip]");
      await expect(strip.locator("li").first()).toBeVisible(ARRIVES);
      const m = await strip.evaluate((s) => {
        const aside = s.closest("[data-slot='with-aside-aside'], aside") ?? s.parentElement!;
        const room = Math.min(aside.getBoundingClientRect().width, document.documentElement.clientWidth);
        const items = [...s.querySelectorAll(":scope li, :scope > a, :scope > [data-slot='button']")].map((el) => Math.round(el.getBoundingClientRect().width));
        return { room: Math.round(room), widest: Math.max(...items) };
      });
      expect(m.widest, `widest strip item vs the rail's ${m.room}px`).toBeLessThanOrEqual(m.room);
    });
  }
});
