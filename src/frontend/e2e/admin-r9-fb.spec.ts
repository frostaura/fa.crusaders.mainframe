import { type Locator, type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes } from "./playersKit";
import { sideways } from "./layoutKit";

// A cold dev server compiles the admin frame on first ask, and the machine is shared.
test.describe.configure({ timeout: 90_000 });

/**
 * Review round 9, lane FB9 (admin UI) — measured in Chromium against a mocked API: where focus
 * lands after a dialog is dismissed, and how rows and labels wrap at 200 % text.
 */

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
    { path: "/api/v1/admin/members/", body: [] },
    { path: "/api/v1/admin/settings/", body: { timezone: "Africa/Johannesburg", slice_minutes: 15 } },
  ];
}

async function open(page: Page, path: string, routes: ApiRoute[], width = 1280, height = 900) {
  await page.setViewportSize({ width, height });
  await signIn(page);
  await serveApi(page, routes);
  await page.goto(path);
}

async function big(page: Page) {
  await page.addStyleTag({ content: "html { font-size: 32px; }" });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
}

/**
 * Words cut across lines ("Adjus/tments", "P/a/y/e/r"); a break after a hyphen is a real break.
 * Strict: a word wider than its whole box counts too — that box is the defect (it should have
 * stepped down), not an excuse for the cut.
 */
function brokenWords(el: Locator): Promise<string[]> {
  return el.evaluate((root) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      if (node.parentElement?.closest(".sr-only, [aria-hidden='true']")) continue;
      for (const m of text.matchAll(/[^\s\u00a0\-\u2013]+[-\u2013]?/g)) {
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

/** Where focus is, by a name a person would recognise; "<body>"/"<main>" when it fell off. */
const focused = (page: Page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return "<body>";
  if (el.tagName === "MAIN") return "<main>";
  return el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 60) ?? el.tagName;
});

/* ───────────────────────────── Packages: X9-1 Retire's way out, L9-5 the Actions cell ───────────────────────────── */

const pkg = (id: string, name: string, minutes: number, price: number, order: number) => ({
  id, name, minutes, price_zar: price, group: null, sort_order: order, status: "active",
  created_at: "2026-09-01T08:00:00Z", updated_at: "2026-09-01T08:00:00Z",
});
const PACKAGES = [pkg("p-1", "1 hour", 60, 120, 0), pkg("p-5", "5 hours", 300, 550, 1), pkg("p-10", "10 hours", 600, 1000, 2)];
const packageRoutes = () => adminRoutes([{ path: "/api/v1/admin/packages", body: { packages: PACKAGES } }]);

test.describe("X9-1 — dismissing Retire gives focus back to that row's ⋯", () => {
  for (const [width, how] of [[1280, "Escape"], [1280, "Cancel"], [390, "Escape"], [390, "Cancel"]] as const) {
    test(`${how} at ${width}`, async ({ page }) => {
      await open(page, "/admin/packages", packageRoutes(), width);
      const menu = page.getByRole("button", { name: "Actions for 5 hours" });
      await menu.focus({ timeout: 30_000 });
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Retire" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      if (how === "Escape") await page.keyboard.press("Escape");
      else await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => focused(page)).toBe("Actions for 5 hours");
    });
  }
});

test.describe("L9-5 — the Packages Actions cell keeps ⋯ beside Edit", () => {
  for (const width of [1024, 1280, 1920]) {
    test(`at ${width}`, async ({ page }) => {
      await open(page, "/admin/packages", packageRoutes(), width);
      const row = page.locator("tr[data-package-row='p-5']");
      await expect(row).toBeVisible({ timeout: 30_000 });
      const edit = (await row.getByRole("button", { name: "Edit 5 hours" }).boundingBox())!;
      const dots = (await row.getByRole("button", { name: "Actions for 5 hours" }).boundingBox())!;
      // One line: ⋯ sits beside Edit, not under it.
      expect(Math.abs((dots.y + dots.height / 2) - (edit.y + edit.height / 2)), "⋯ dropped under Edit").toBeLessThan(4);
      expect(dots.x).toBeGreaterThan(edit.x + edit.width - 1);
      // The table fits the box it was given: no column pushed out of view to make room.
      const scroller = page.locator("[data-slot='table-container']").first();
      expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth), "the shelf table scrolls sideways").toBeLessThanOrEqual(1);
      expect(await sideways(page)).toBeLessThanOrEqual(1);
    });
  }
});

/* ───────────────────────────── L9-3 the club door log beside the rail at 200 % ───────────────────────────── */

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
const logRow = (i: number, name: string, action: string, reason: string) => ({
  at: ago(600 + i * 60), action, reason, offline: false, member: { id: `00000000-0000-0000-0000-00000000000${i}`, name },
  fingerprint: "1f2e3d4c", door: { id: "d-1", name: "Side door", gate_key: "side-door" },
});

test.describe("L9-3 — a door log row never squeezes the member's name to a letter a line", () => {
  for (const width of [1024, 1280]) {
    test(`at ${width} / 200 %`, async ({ page }) => {
      await open(page, "/admin/doors/log", adminRoutes([
        { path: "/api/v1/admin/doors/activity", body: { items: [
          logRow(1, "Ben Payer", "gate.denied_no_booking", "no_booking"),
          logRow(2, "Ava Organiser", "gate.opened", "ok"),
          logRow(3, "Cleo Walker", "gate.denied_member_not_active", "member_not_active"),
        ], next_cursor: null, retention_days: 90 } },
      ]), width);
      const rows = page.locator("main li").filter({ hasText: "Whose code" });
      await expect(rows.first()).toBeVisible({ timeout: 30_000 });
      // At ordinary text size a wide row keeps its three columns.
      expect(await rows.first().locator(":scope > div").first().evaluate((el) => getComputedStyle(el).display)).toBe("grid");
      await big(page);
      for (let i = 0; i < 3; i++) {
        expect(await brokenWords(rows.nth(i)), `row ${i}: a word cut across lines`).toEqual([]);
      }
      expect(await sideways(page)).toBeLessThanOrEqual(1);
    });
  }
});

/* ───────────────────────────── L9-6 Reports' stat-tile labels at 200 % ───────────────────────────── */

const DAY = (i: number) => ({
  date: `2026-09-${String(i + 1).padStart(2, "0")}`, top_ups_minutes: 2280, booking_charges_minutes: 4215, refunds_minutes: -1755,
  penalties_minutes: 69, adjustments_minutes: 19810, reversals_minutes: -60, share_transfers_minutes: 0,
  net_movement_minutes: -122, bookings: 29, no_shows: 7,
});
const reportRoutes = () => adminRoutes([
  { path: "/api/v1/admin/reports/revenue", body: { from: "", to: "", gross_topups_zar: 3680, reversals_zar: 0, net_zar: 3680, gross_topups_minutes: 2280, reversals_minutes: 0, net_minutes: 2280, zar_per_minute_sold: 1.614 } },
  { path: "/api/v1/admin/reports/utilisation", body: { from: "", to: "", by_court: [
    { court_id: "c-1", court_name: "Court 1", bookings: 4, booked_minutes: 180, sold_minutes: 180, kept_minutes: 135 },
  ] } },
  { path: "/api/v1/admin/reports/no-shows", body: { from: "", to: "", total: 24, no_show: 2, no_show_pct: 8.3 } },
  { path: "/api/v1/admin/reports/daily", body: Array.from({ length: 3 }, (_, i) => DAY(i)) },
]);

test.describe("L9-6 — Reports' tile and totals labels never break inside a word", () => {
  for (const width of [320, 390, 768, 1280]) {
    test(`at ${width} / 200 %`, async ({ page }) => {
      await open(page, "/admin/reports", reportRoutes(), width);
      await expect(page.locator("[data-stat-tiles]")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("region", { name: "Daily breakdown" }).getByRole("table")).toBeVisible();
      const labels = page.locator("main dt, main th");
      // At ordinary text the labels keep the overline's capitals.
      expect(await labels.first().evaluate((el) => getComputedStyle(el).textTransform)).toBe("uppercase");
      for (const pass of ["100 %", "200 %"]) {
        if (pass === "200 %") await big(page);
        const n = await labels.count();
        expect(n).toBeGreaterThan(4);
        const broken: string[] = [];
        for (let i = 0; i < n; i++) broken.push(...await brokenWords(labels.nth(i)));
        expect(broken, `${pass}: a label cut inside a word`).toEqual([]);
      }
      expect(await sideways(page)).toBeLessThanOrEqual(1);
    });
  }
});

/** FC9's ask: the member's wallet activity draws its totals with the same `Stat` / `StatTiles`. */
test.describe("L9-6 — Wallet activity's totals labels never break inside a word", () => {
  for (const width of [320, 390]) {
    test(`at ${width} / 200 %`, async ({ page }) => {
      const day = (n: number) => ({ date: `2026-09-0${n}`, top_ups_minutes: 0, spent_minutes: 50, refunds_minutes: 0, bookings: 1, attended: 1, minutes_on_court: 45, balance_minutes: 300 });
      await page.setViewportSize({ width, height: 800 });
      await signIn(page);
      await serveApi(page, [
        ...memberShellRoutes({ wallet: { balance_minutes: 300, held_minutes: 0, spendable_minutes: 300, entries: [], total_entries: 0, limit: 50 } }),
        { path: "/api/v1/reports/me/wallet", body: {
          from: "2026-09-01", to: "2026-09-30", top_ups_minutes: 300, spent_minutes: 150, refunds_minutes: 0, penalties_minutes: 0,
          adjustments_minutes: 0, reversals_minutes: 0, net_movement_minutes: 150, penalty_count: 0, attended_bookings: 3,
          bookings: 3, minutes_on_court: 135, count: 6,
        } },
        { path: "/api/v1/reports/me/daily", body: [day(1), day(2), day(3)] },
      ]);
      await page.goto("/wallet/activity");
      const labels = page.locator("main dt");
      await expect(labels.first()).toBeVisible({ timeout: 30_000 });
      await big(page);
      const n = await labels.count();
      const broken: string[] = [];
      for (let i = 0; i < n; i++) broken.push(...await brokenWords(labels.nth(i)));
      expect(broken, "a label cut inside a word").toEqual([]);
      expect(await sideways(page)).toBeLessThanOrEqual(1);
    });
  }
});
