import type { Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { fontsReady } from "./layoutKit";
import { BOOKING, CLUB_ZONE, ME, detailFixture, memberShellRoutes, tomorrowAt } from "./playersKit";
import { myPlayFixture } from "./playKit";
import { deviceErrorPageFixture } from "../src/test/monitoringFixtures";

/**
 * R11 (L11-2 / L11-4 / L11-5 / L11-6 / L10-1) — every control on every route, at 320 × 640 with
 * 200 % text, held inside its box.
 *
 * <p>
 * Round 11 found the same defect on six screens at once — a button that would not wrap ran past
 * the gutter ("Create a group", "See all 20 alerts", "Show 50 more", "New endpoint", "Download
 * CSV", "Try again now") — and the spec that caught each earlier one was about its own screen, so
 * the next screen was free to repeat it. This one walks every member and admin route and fails on
 * any button, input or select whose box leaves the viewport, its scroll container or the content
 * box of any ancestor below a horizontal scroller (the gutter, a card's padding), any control whose
 * own text paints outside it, any word split across two lines inside a control ("Cance / l"), and
 * any figure split from the word after it ("Last 7 / days", "Sat 3 / Oct").
 * </p>
 *
 * <p>
 * Held red-first by replaying the old primitives through a stylesheet (buttons `nowrap` with no
 * `max-width`, DialogBody rows shrinkable): eleven routes went red, among them "Cancel booking",
 * "Download CSV", "Show 10 more" and "Save changes" — the round-11 set.
 * </p>
 *
 * <p>
 * The data is thin but populated where a finding lived: sixty members (so "Show 50 more" draws),
 * twenty alerts, two webhooks, three groups, a split booking. A route that asks for something
 * not stubbed here gets the strict 501 and draws its failed state — whose "Try again" is
 * measured too. Content inside a horizontal scroller (a table, a tab strip) is reachable by
 * scrolling and is not an overflow.
 * </p>
 */

test.describe.configure({ timeout: 90_000 });

const MEMBER_ROUTES = ["/my-code", "/bookings", "/bookings/invites", `/bookings/${BOOKING}`, "/inbox", "/wallet", "/wallet/buy",
  "/wallet/activity", "/profile", "/profile/results", "/change-password", "/get-started", "/how-it-works"];
const ADMIN_ROUTES = ["/admin", "/admin/members", `/admin/members/${ME}`, `/admin/members/${ME}/wallet`, `/admin/members/${ME}/bookings`,
  `/admin/members/${ME}/doors`, `/admin/members/${ME}/night`, `/admin/members/${ME}/access`, "/admin/groups", "/admin/packages",
  "/admin/results", "/admin/transactions", "/admin/reports", "/admin/monitoring", "/admin/monitoring/doors",
  "/admin/monitoring/doors/log", "/admin/monitoring/devices", "/admin/monitoring/faults", "/admin/monitoring/changes",
  "/admin/monitoring/night", "/admin/schedules", "/admin/courts", "/admin/settings", "/admin/webhooks"];

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const SETTINGS = {
  slice_minutes: 15, advance_booking_days: 14, day_start_minute: 360, day_end_minute: 1320,
  penalty_pct: 30, grace_window_minutes: 5, penalty_window_minutes: 15, timezone: CLUB_ZONE,
  button_map: ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "off"],
  operating_hours: { mon: "06:00-22:00", sat: "07:00-20:00" }, topup_block_zar: 100, topup_max_zar_per_member: 1000,
  member_per_day_max_minutes: 60, member_max_slots_per_day: 4, peak_hours: "16:00-19:00", peak_advance_hours_for_regular: 1,
  retention_years: 2, no_show_lookback_days: 7, walk_up_max_minutes: 90, heartbeat_seconds: 60,
  activation_forward_window_minutes: 120, activation_cue_window_minutes: 10, qr_lifetime_seconds: 60,
  roster_window_minutes: 120, device_alert_cooldown_minutes: 60, currency_symbol: "R",
};

function member(i: number) {
  return {
    user_id: i === 0 ? ME : `00000000-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`,
    membership_id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
    full_name: i === 0 ? "Bartholomew Fitzwilliam-Khumalo" : `Member ${i}`, email: `member.${i}@overflow.review.test`,
    membership_number: `MEM-10${String(i).padStart(2, "0")}`, status: i % 7 === 3 ? "Suspended" : "Active", email_verified: true,
    balance_minutes: 120, created_at: "2026-09-05T08:00:00Z", photo_url: null, is_admin: false, admin_source: null,
    groups: [{ id: "g-social", name: "Social evenings", system_key: null, package_discount_bps: null, peak_priority: false }],
  };
}

const MEMBER_DETAIL = {
  ...member(0), account_status: "Active", last_login_at: null, passkey_count: 1, fingerprints: { count: 0, enrolments: [] },
  next_bookings: [], counts_30d: { bookings: 6, no_shows: 1, sessions_played: 5 },
};

function group(overrides: Record<string, unknown>) {
  return {
    description: null, status: "active", sort_order: 0, is_system_default: false,
    caps: { max_slots_per_day: null, max_minutes_per_day: null, advance_booking_days: null },
    windows: [], member_count: 0, system_key: null, package_discount_bps: null, peak_priority: null, ...overrides,
  };
}

const GROUPS = [
  group({ id: "g-league", name: "League members", system_key: "league", package_discount_bps: 1000, peak_priority: true, member_count: 41 }),
  group({ id: "g-social", name: "Social evenings", description: "Weeknight social squash", member_count: 17, sort_order: 1,
    caps: { max_slots_per_day: 2, max_minutes_per_day: null, advance_booking_days: 7 } }),
  group({ id: "g-non", name: "Non-league members", member_count: 120, sort_order: 2 }),
];

const PACKAGES = { packages: [{
  id: "p-social", name: "Social 5 hours", minutes: 300, price_zar: 450, group: { id: "g-social", name: "Social evenings" },
  sort_order: 0, status: "active", created_at: "2026-09-01T08:00:00Z", updated_at: "2026-09-01T08:00:00Z",
}] };

const ALERTS = {
  items: Array.from({ length: 20 }, (_, i) => ({
    id: `n${i}`, kind: i % 2 ? "device.offline" : "member.registered",
    title: i % 2 ? "Court box or door stopped reporting" : "New membership applications",
    headline: i % 2 ? "Door gate-598a9a stopped reporting to the administrator" : "Sevenadmin Adminwell applied for membership",
    link: i % 2 ? "/admin/monitoring/devices" : "/admin/members", subject_user_id: null, created_at: ago(5 + i * 30),
    delivery: { state: "sent", sent_at: ago(4 + i * 30), finished_at: ago(4 + i * 30), recipients: 3 },
  })),
  next_cursor: null,
};

const HOOKS = ["a", "b"].map((x, i) => ({
  id: `00000000-0000-4000-8000-00000000072${i}`, owner_kind: "Tenant", description: null,
  url_template: `https://hook-${x}.overflow.review.test/{event}`, event_filter: "booking.created,minutes.refunded", enabled: i === 0,
  failure_count: i, last_success_at: null, last_failure_at: null, secret: null,
}));

const DAY = (i: number) => ({
  date: `2026-09-${String(i + 1).padStart(2, "0")}`, top_ups_minutes: 600, booking_charges_minutes: 540, refunds_minutes: -45,
  penalties_minutes: 13, adjustments_minutes: 0, reversals_minutes: -60, share_transfers_minutes: 0, net_movement_minutes: -122,
  bookings: 12, no_shows: 2, spent_minutes: 40, attended: 1, minutes_on_court: 60, balance_minutes: 500,
});

const MEMBER_BASE = `/api/v1/admin/members/${ME}`;

function routes(): ApiRoute[] {
  return [
    ...memberShellRoutes({ admin: true }),
    { path: "/api/v1/whoami", body: { ...SESSION_ADMIN, user_id: ME } },
    { path: "/api/v1/me/code/enrol", method: "POST", status: 503, body: { error: "unavailable" } },
    { path: "/api/v1/me/webauthn/credentials", body: [] },
    { path: `/api/v1/bookings/${BOOKING}`, body: detailFixture() },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: CLUB_ZONE, items: [] } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: CLUB_ZONE, items: [] } },
    {
      path: "/api/v1/schedule",
      body: {
        date: tomorrowAt(10).slice(0, 10), timezone: CLUB_ZONE, sliceMinutes: 15, dayStartMinute: 360, dayEndMinute: 1320,
        advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 120,
        courts: [1, 2, 3, 4].map((n) => ({ id: `c${n}`, courtNumber: n, name: `Court ${n}`, slicePriceCredits: 15 })), slots: [],
      },
    },
    { path: "/api/v1/reports/me/wallet", body: { from: "2026-09-01", to: "2026-09-03", top_ups_minutes: 1600, spent_minutes: 400, refunds_minutes: 0,
      penalties_minutes: 0, adjustments_minutes: 0, reversals_minutes: 0, net_movement_minutes: 1200, penalty_count: 0, attended_bookings: 3, minutes_on_court: 180 } },
    { path: "/api/v1/reports/me/daily", body: [0, 1, 2].map(DAY) },
    { path: "/api/v1/minutes/packages", body: { discount: null, open_checkouts: [], packages: [
      { id: "p-1", name: "1 hour", minutes: 60, price_zar: 120, list_price_zar: 120, discount_bps: null, group: null },
      { id: "p-5", name: "5 hours of evening squash", minutes: 300, price_zar: 550, list_price_zar: 550, discount_bps: null, group: null },
    ] } },
    { path: "/api/v1/me/notifications", body: { items: [{ id: "n1", kind: "players.invited", headline: "Sam asked you to play — Court 1",
      link: `/bookings/${BOOKING}`, booking_id: BOOKING, created_at: ago(5), read_at: null }], unread_count: 1, next_cursor: null } },
    { path: "/api/v1/me/play", body: myPlayFixture() },
    { path: "/api/v1/me/play/results", body: { timezone: CLUB_ZONE, items: [], next_cursor: null } },
    // Admin.
    { path: "/api/v1/admin/members/", body: Array.from({ length: 60 }, (_, i) => member(i)) },
    { path: MEMBER_BASE, body: MEMBER_DETAIL },
    { path: `${MEMBER_BASE}/play`, body: { sessions_attended: 0, minutes_this_month: 0, minutes_all_time: 0, current_streak_weeks: 0,
      matches_played: 0, matches_won: 0, matches_lost: 0, open_disputes: 0, badges_earned: 0 } },
    { path: `${MEMBER_BASE}/bookings`, body: { when: "upcoming", items: [], next_cursor: null } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: { critical: 3, error: 2 } } },
    { path: "/api/v1/admin/play/results/disputed/count", body: { count: 0 } },
    { path: "/api/v1/admin/play/results", body: { items: [], next_cursor: null, timezone: CLUB_ZONE } },
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: CLUB_ZONE } },
    { path: "/api/v1/admin/doors/activity", body: { items: [], next_cursor: null, retention_days: 90 } },
    { path: "/api/v1/admin/notifications", body: ALERTS },
    { path: "/api/v1/admin/member-groups", body: { groups: GROUPS } },
    { path: "/api/v1/admin/packages", body: PACKAGES },
    { path: "/api/v1/admin/settings/", body: SETTINGS },
    { path: "/api/v1/admin/ledger/", body: [] },
    { path: "/api/v1/admin/reports/revenue", body: { from: "", to: "", gross_topups_zar: 2025, reversals_zar: 0, net_zar: 2025,
      gross_topups_minutes: 1800, reversals_minutes: 0, net_minutes: 1800, zar_per_minute_sold: 1.125 } },
    { path: "/api/v1/admin/reports/utilisation", body: { from: "", to: "", by_court: [{ court_id: "c-1", court_name: "Court 1", bookings: 4,
      booked_minutes: 180, sold_minutes: 180, kept_minutes: 135 }] } },
    { path: "/api/v1/admin/reports/no-shows", body: { from: "", to: "", total: 24, no_show: 2, no_show_pct: 8.3 } },
    { path: "/api/v1/admin/reports/daily", body: [0, 1, 2].map(DAY) },
    { path: "/api/v1/admin/control-board", body: { generated_at: new Date().toISOString(), timezone: CLUB_ZONE, courts: [] } },
    { path: "/api/v1/admin/control-board/stream-ticket", method: "POST", status: 503, body: { error: "stream_unavailable" } },
    { path: "/api/v1/admin/devices/api-key", body: { api_key: "cmk_9F2Kq7Xd4bTn6Ls0", regenerated_at: "2026-09-01T08:30:00Z" } },
    { path: "/api/v1/admin/devices/", body: [] },
    { path: "/api/v1/admin/courts/", body: [] },
    { path: "/api/v1/admin/monitoring/errors", body: deviceErrorPageFixture([]) },
    { path: "/api/v1/admin/changes", body: { items: [], next_cursor: null, timezone: CLUB_ZONE } },
    { path: "/api/v1/admin/schedules", body: { schedules: [], timezone: CLUB_ZONE } },
    { path: "/api/v1/admin/webhooks/", body: HOOKS },
  ];
}

/** The club's text at twice the size, from the first paint (gotchas-frontend-layout: html 32px). */
async function enlarge(page: Page) {
  await page.addInitScript(() => {
    const big = () => { document.documentElement.style.fontSize = "32px"; };
    if (document.documentElement) big();
    document.addEventListener("DOMContentLoaded", big);
  });
}

/**
 * Every visible control, measured: its box against the viewport, its nearest clipping or
 * scrolling ancestor and its parent's content box; its own text against its box; each word and
 * figure inside it on one line. Content inside a horizontal scroller is skipped (it scrolls).
 */
function scan(): string[] {
  const out: string[] = [];
  const vw = window.innerWidth;
  const name = (el: Element) => ((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "")
    .trim().replace(/\s+/g, " ").slice(0, 32);
  const scrollsX = (el: Element) => {
    const o = getComputedStyle(el).overflowX;
    return (o === "auto" || o === "scroll") && el.scrollWidth > el.clientWidth + 1;
  };
  const inScrollerX = (el: Element) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (scrollsX(p)) return true;
    return false;
  };
  const clipper = (el: Element) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== "visible") return p;
    }
    return null;
  };
  /** The first ancestor (below any horizontal scroller) whose content box the control runs past. */
  const pastAncestor = (el: Element, r: DOMRect) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (scrollsX(p)) return null;
      const cs = getComputedStyle(p);
      if (cs.display === "contents" || cs.display === "inline") continue;
      const b = p.getBoundingClientRect();
      const left = b.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
      const right = b.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
      if (r.right > right + 2 || r.left < left - 2) {
        return `${p.tagName.toLowerCase()}.${String(p.className).split(" ").slice(0, 3).join(".")} (${Math.round(r.right)} > ${Math.round(right)})`;
      }
    }
    return null;
  };
  const controls = document.querySelectorAll("button, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea, [role=combobox], [data-slot=button]");
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || el.closest("[aria-hidden=true], [inert]")) continue;
    if (getComputedStyle(el).visibility === "hidden" || inScrollerX(el)) continue;
    const tag = `${el.tagName.toLowerCase()} "${name(el)}"`;
    if (r.right > vw + 1 || r.left < -1) { out.push(`${tag} leaves the screen (${Math.round(r.left)}–${Math.round(r.right)} of ${vw})`); continue; }
    const clip = clipper(el);
    if (clip) {
      const c = clip.getBoundingClientRect();
      if (r.right > c.right + 1 || r.left < c.left - 1) out.push(`${tag} leaves its scroll container (${Math.round(r.right)} > ${Math.round(c.right)})`);
    }
    const past = pastAncestor(el, r);
    if (past) out.push(`${tag} runs past the content box of ${past}`);
    // Its own text: painted inside it, and no word or figure split across two lines.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const parent = node.parentElement;
      if (!parent || parent.closest("[aria-hidden=true]") !== null && el.contains(parent.closest("[aria-hidden=true]"))) continue;
      let clamped = false;
      for (let p: Element | null = parent; p && p !== el; p = p.parentElement) if (getComputedStyle(p).overflow !== "visible") clamped = true;
      if (clamped) continue;
      const range = document.createRange();
      // A figure and the word after it ("15 minutes", "3 Oct") on one line.
      for (const m of node.data.matchAll(/\d+[ \u00a0]+\p{L}+/gu)) {
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const tops = new Set([...range.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)));
        if (tops.size > 1) out.push(`${tag} splits the figure "${m[0]}" from its unit`);
      }
      for (const m of node.data.matchAll(/[^ \t\n\r]+/g)) {
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const rects = [...range.getClientRects()].filter((x) => x.width > 0);
        if (rects.length > 1) out.push(`${tag} splits "${m[0]}" across lines`);
        for (const t of rects) {
          if (t.right > r.right + 1 || t.left < r.left - 1 || t.bottom > r.bottom + 1 || t.top < r.top - 1) {
            out.push(`${tag} paints "${m[0]}" outside its box`);
            break;
          }
        }
      }
    }
  }
  return [...new Set(out)];
}

async function settle(page: Page) {
  await expect(page.locator("h1").first()).toBeAttached({ timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector("[data-slot=skeleton]"), null, { timeout: 15_000 }).catch(() => null);
  await fontsReady(page);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), "the 32px root really applied").toBe("32px");
}

test.describe("R11 — every control stays inside its box at 320 × 640 with 200 % text", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "mobile", "one phone; the size is set per test"); });

  for (const route of [...MEMBER_ROUTES, ...ADMIN_ROUTES]) {
    test(route.replace(/[0-9a-f-]{36}/, ":id"), async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await signIn(page);
      await enlarge(page);
      await serveApi(page, routes());
      await page.goto(route);
      await settle(page);
      expect(await page.evaluate(scan), `${route}: controls out of their box`).toEqual([]);
    });
  }

  test("a docked bar with nothing in it never paints an empty pill (a full booking has no Invite)", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await signIn(page);
    await enlarge(page);
    await serveApi(page, routes());
    await page.goto(`/bookings/${BOOKING}`);
    await settle(page);
    // detailFixture() seats four — MAX_SEATS — so InviteButton renders nothing in the dock.
    const panels = await page.locator("[data-context-bar=bottom]").evaluateAll((bars) => bars
      .filter((bar) => bar.getBoundingClientRect().height > 0)
      .map((bar) => (bar as HTMLElement).innerText.trim()));
    expect(panels.filter((text) => text === "")).toEqual([]);
  });

  for (const [status, body] of [[503, { error: "unavailable" }], [429, { error: "rate_limited", retry_after_seconds: 30 }]] as const) {
    test(`the connection screen's 'Try again now' after a ${status} (L11-5)`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await signIn(page);
      await enlarge(page);
      await serveApi(page, [{ path: "/api/v1/whoami", status, body }]);
      await page.goto("/my-code");
      await expect(page.getByRole("button", { name: /try again/i })).toBeVisible({ timeout: 30_000 });
      await fontsReady(page);
      expect(await page.evaluate(scan)).toEqual([]);
    });
  }
});
