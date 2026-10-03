import type { Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { bigText, fontsReady, sideways, textOffScreen } from "./layoutKit";
import { memberShellRoutes } from "./playersKit";

/**
 * Review round 8, lane FD2 — buying, wallet activity and the inbox, measured in a real engine.
 *
 * <ul>
 *   <li>L8-2 — "Purchases waiting on PayFast": a row's words went one per line at 390 / 200 % (a
 *   zero-basis `flex-1` beside Cancel never wraps to its own line) and "Started at" ran into Cancel.</li>
 *   <li>L8-4 — Wallet activity on a phone: the daily table's sticky head (z 20) painted over the stuck
 *   range bar (z 20, earlier in the DOM); the Date column scrolled away when the table scrolled sideways.</li>
 *   <li>L8-6 — "Download CSV" (a nowrap button) pushed the page 11px sideways at 320 / 200 %.</li>
 *   <li>L8-11 — an inbox row at 390 / 200 %: the icon gutter squeezed kind and time into a column
 *   ("Reply ·" / "Today," / "08:44") with the separator left dangling at a line's end.</li>
 * </ul>
 */

test.describe.configure({ timeout: 120_000 });

test.beforeEach(({ page: _page }, info) => { test.skip(info.project.name !== "desktop", "sized explicitly; one project is enough"); });

const pkg = (id: string, name: string, minutes: number, price: number) => ({
  id, name, minutes, list_price_zar: price, discount_bps: 0, price_zar: price, saving_zar: null, saving_pct: null, source: "club", group: null,
});
const OPEN = [
  { id: "bbbb0000-0000-0000-0000-0000000000b2", package_name: "10 hours", minutes: 600, amount_zar: 1000, created_at: "2026-10-01T12:40:00Z", expires_at: "2026-10-01T13:40:00Z" },
  { id: "aaaa0000-0000-0000-0000-0000000000a1", package_name: "1 hour", minutes: 60, amount_zar: 120, created_at: "2026-10-01T12:05:00Z", expires_at: "2026-10-01T13:05:00Z" },
];

function shelfRoutes(): ApiRoute[] {
  return [
    ...memberShellRoutes(),
    { path: "/api/v1/minutes/packages", body: { discount: null, packages: [pkg("p-1", "1 hour", 60, 120), pkg("p-5", "5 hours", 300, 550)], open_checkouts: OPEN } },
  ];
}

/** The lines a text node's words land on (distinct Range rect tops). */
async function linesOf(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
  });
}

test.describe("L8-2 — purchases waiting on PayFast at large text", () => {
  for (const width of [320, 390] as const) {
    test(`${width} at 200 %: the words take the row's width and never run into Cancel`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await signIn(page);
      await serveApi(page, shelfRoutes());
      await page.goto("/wallet/buy");
      const rows = page.locator("[data-open-checkout]");
      await expect(rows).toHaveCount(2, { timeout: 20_000 });
      await fontsReady(page);
      await bigText(page);
      for (let i = 0; i < 2; i += 1) {
        const row = rows.nth(i);
        const geometry = await row.evaluate((li) => {
          const words = li.firstElementChild as HTMLElement;
          const button = li.querySelector("button")!;
          const w = words.getBoundingClientRect();
          const b = button.getBoundingClientRect();
          const overlaps = !(w.right <= b.left || b.right <= w.left || w.bottom <= b.top || b.bottom <= w.top);
          return { words: w.width, row: li.getBoundingClientRect().width, overlaps };
        });
        expect(geometry.overlaps, "the words and Cancel overlap").toBe(false);
        expect(geometry.words / geometry.row, "the words were squeezed beside Cancel").toBeGreaterThan(0.9);
      }
      expect(await linesOf(page, "[data-open-checkout] span >> nth=0"), "'10 hours for R1,000.00' a word a line").toBeLessThanOrEqual(3);
      expect(await sideways(page)).toBe(0);
      expect(await textOffScreen(page)).toEqual([]);
    });
  }
});

const DAYS = Array.from({ length: 30 }, (_, i) => {
  const day = String(i + 1).padStart(2, "0");
  return {
    date: `2026-09-${day}`, top_ups_minutes: i % 5 === 0 ? 300 : 0, spent_minutes: 45, refunds_minutes: 0, penalties_minutes: i % 7 === 0 ? 15 : 0,
    adjustments_minutes: 0, reversals_minutes: 0, net_movement_minutes: -45, bookings: 1, attended: 1, minutes_on_court: 45, balance_minutes: 600 - i * 10,
  };
});
const WALLET_REPORT = {
  from: "", to: "", top_ups_minutes: 1800, spent_minutes: 1350, refunds_minutes: 0, penalties_minutes: 75, adjustments_minutes: 0, reversals_minutes: 0,
  net_movement_minutes: 375, penalty_count: 5, attended_bookings: 30, minutes_on_court: 1350, count: 41,
};

function activityRoutes(): ApiRoute[] {
  return [
    ...memberShellRoutes(),
    { path: "/api/v1/reports/me/wallet", body: WALLET_REPORT },
    { path: "/api/v1/reports/me/daily", body: DAYS },
  ];
}

async function openActivity(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await signIn(page);
  await serveApi(page, activityRoutes());
  await page.goto("/wallet/activity");
  await expect(page.getByRole("heading", { name: "Daily breakdown" })).toBeVisible({ timeout: 20_000 });
  await fontsReady(page);
}

test.describe("L8-4 — Wallet activity's stuck range bar and the daily table", () => {
  test("390: the table's head scrolls UNDER the stuck range bar, never over it", async ({ page }) => {
    await openActivity(page, 390, 844);
    const bar = page.locator("[data-range-bar]");
    await expect(bar).toHaveAttribute("data-sticks", "true");
    // Bring the table up under the bar: its head, sticky inside the table, now shares the bar's rows.
    const covered = await page.evaluate(() => {
      const main = document.getElementById("main-content")!;
      const table = document.querySelector("[data-slot=table-container]")!;
      const barEl = document.querySelector("[data-range-bar]")!;
      // Twice: the bar only reaches its stuck place once the page has scrolled under it.
      for (let i = 0; i < 2; i += 1) main.scrollTop += table.getBoundingClientRect().top - barEl.getBoundingClientRect().top;
      return new Promise<string[]>((resolve) => requestAnimationFrame(() => {
        const b = barEl.getBoundingClientRect();
        const out: string[] = [];
        for (const fy of [0.5, 0.75, 0.95]) {
          for (const fx of [0.2, 0.5, 0.8]) {
            const hit = document.elementFromPoint(b.left + b.width * fx, b.top + b.height * fy);
            if (hit && !barEl.contains(hit)) out.push(`${hit.tagName}.${hit.getAttribute("data-slot") ?? ""}@${fx},${fy}`);
          }
        }
        // The probe only means something with the table under the bar.
        if (table.getBoundingClientRect().top >= b.bottom) out.push("table never reached the bar");
        resolve(out);
      }));
    });
    expect(covered, "something painted over the stuck range bar").toEqual([]);
  });

  test("390: the Date column stays put while the daily table scrolls sideways", async ({ page }) => {
    await openActivity(page, 390, 844);
    const container = page.locator("[data-slot=table-container]");
    const wider = await container.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(wider, "the table must be wider than a phone for this to mean anything").toBeGreaterThan(40);
    const left = await container.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
      const box = el.getBoundingClientRect();
      const date = el.querySelector("tbody tr td")!.getBoundingClientRect();
      const head = el.querySelector("thead th")!.getBoundingClientRect();
      return { date: date.left - box.left, head: head.left - box.left };
    });
    expect(Math.abs(left.date), "the Date cell scrolled away").toBeLessThanOrEqual(2);
    expect(Math.abs(left.head), "the Date head scrolled away").toBeLessThanOrEqual(2);
    // The pinned cell is opaque: the figure scrolling under it does not show through.
    const bg = await container.evaluate((el) => getComputedStyle(el.querySelector("tbody tr td")!).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
  });
});

test.describe("L8-6 — Download CSV at 320 / 200 %", () => {
  test("wraps inside the range card instead of pushing the page sideways", async ({ page }) => {
    await openActivity(page, 320, 640);
    await bigText(page);
    const csv = page.getByRole("button", { name: "Download CSV" });
    await expect(csv).toBeVisible();
    expect(await sideways(page), "the page scrolls sideways").toBe(0);
    const right = await csv.evaluate((el) => el.getBoundingClientRect().right);
    expect(right).toBeLessThanOrEqual(320);
  });
});

const AT = new Date(Date.now() - 5 * 60_000).toISOString();
const NOTICES = [
  { id: "n1", kind: "players.response", headline: "Rita Rally accepted — Court 1, Tue 6 Oct, 10:00", link: "/bookings/b1", booking_id: "b1", created_at: AT, read_at: null },
  { id: "n2", kind: "players.share_moved", headline: "Rita Rally paid you 30 minutes", link: null, booking_id: null, created_at: AT, read_at: null },
];

test.describe("L8-11 — an inbox row at 390 / 200 %", () => {
  test("kind and time are never squeezed into a column, and no separator dangles", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await serveApi(page, [
      ...memberShellRoutes({ unread: 2 }),
      { path: "/api/v1/me/notifications", body: { items: NOTICES, unread_count: 2, next_cursor: null } },
    ]);
    await page.goto("/inbox");
    const rows = page.locator("li[data-notification]");
    await expect(rows).toHaveCount(2, { timeout: 20_000 });
    await fontsReady(page);
    await bigText(page);
    for (let i = 0; i < 2; i += 1) {
      const row = rows.nth(i);
      const facts = await row.evaluate((li) => {
        const time = li.querySelector("time")!;
        const range = document.createRange();
        range.selectNodeContents(time);
        const timeLines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
        // A visible "·" that ends or starts a line is a dangling separator.
        const dots = [...li.querySelectorAll("span")].filter((s) => s.textContent === "·" && s.getClientRects().length > 0 && getComputedStyle(s).display !== "none");
        const dangling = dots.filter((dot) => {
          const d = dot.getBoundingClientRect();
          const t = time.getClientRects()[0];
          return !t || Math.abs(t.top - d.top) > 4;
        }).length;
        return { timeLines, dangling };
      });
      expect(facts.timeLines, "'Today, 08:44' broke over two lines").toBe(1);
      expect(facts.dangling, "a separator left at a line's end").toBe(0);
    }
    expect(await sideways(page)).toBe(0);
    expect(await textOffScreen(page)).toEqual([]);
  });

  test("1280 at 200 %: kind · time still read on one line", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page);
    await serveApi(page, [
      ...memberShellRoutes({ unread: 2 }),
      { path: "/api/v1/me/notifications", body: { items: NOTICES, unread_count: 2, next_cursor: null } },
    ]);
    await page.goto("/inbox");
    await expect(page.locator("li[data-notification]")).toHaveCount(2, { timeout: 20_000 });
    await fontsReady(page);
    await bigText(page);
    const sameLine = await page.locator("li[data-notification]").first().evaluate((li) => {
      const time = li.querySelector("time")!.getBoundingClientRect();
      const dot = [...li.querySelectorAll("span")].find((s) => s.textContent === "·")!;
      return getComputedStyle(dot).display !== "none" && Math.abs(dot.getBoundingClientRect().top - time.top) < 8;
    });
    expect(sameLine).toBe(true);
  });
});
