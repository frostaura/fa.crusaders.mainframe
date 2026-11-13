import type { Page } from "@playwright/test";
import { SESSION_ANON, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes } from "./playersKit";

/**
 * Dean, 2026-10 — two shell defects seen on an iPhone, and the title clean-up that came with them.
 *
 * <ol>
 *   <li><b>The top bar is ONE row on every phone.</b> From a 24rem bar (393–430 px) the club's name
 *   joined the crest; the crest box was `shrink-0` in a `flex-wrap justify-end` row, so the row
 *   wrapped — the crest alone, right-aligned, on line one; bell, chip and avatar on line two
 *   (101 px of bar at 430, measured). Red at 430 before the fix.</li>
 *   <li><b>The booking grid fills the room and scrolls itself; the page holds still.</b> `<main>`
 *   (the shell's scroller — the document never scrolls, `document-scroll.spec`) scrolled 300 px
 *   around a grid that scrolled too. Red before the fix (main 1089 / 795 at 393 × 852).</li>
 *   <li><b>A page the nav already names paints no title</b> — its h1 stays for screen readers.</li>
 * </ol>
 */

const COURTS = ["a", "b", "c", "d"].map((x, i) => ({ id: `aaaaaaaa-0000-4000-8000-00000000000${x}`, courtNumber: i + 1, name: `Court ${i + 1}` }));
const DAY = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 2); return d.toISOString().slice(0, 10); })();

function routes(options: { admin?: boolean; balance?: number } = {}): ApiRoute[] {
  return [
    { path: "/api/v1/schedule", body: { date: DAY, timezone: "UTC", sliceMinutes: 15, dayStartMinute: 6 * 60, dayEndMinute: 22 * 60,
      advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: COURTS, slots: [] } },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: "UTC", items: [] } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: "UTC", items: [] } },
    ...memberShellRoutes({
      admin: options.admin,
      wallet: options.balance === undefined ? {} : { balance_minutes: options.balance, spendable_minutes: options.balance, held_minutes: 0 },
    }),
  ];
}

async function open(page: Page, path: string, options: { admin?: boolean; balance?: number; dark?: boolean } = {}) {
  await signIn(page);
  if (options.dark) await page.addInitScript(() => window.localStorage.setItem("crusaders:theme", "dark"));
  await serveApi(page, routes(options));
  await page.goto(path);
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
}

/** Every in-flow child of the bar's row (the phone's tab bar is fixed and not part of it). */
function barRow(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector<HTMLElement>("header[data-app-header]")!;
    const row = header.querySelector<HTMLElement>(":scope > div")!;
    const kids = [...row.children].filter((k) => getComputedStyle(k).position !== "fixed")
      .map((k) => k.getBoundingClientRect()).filter((b) => b.width > 0);
    return {
      height: Math.round(header.getBoundingClientRect().height),
      tops: kids.map((b) => Math.round(b.top)),
      overflow: row.scrollWidth - row.clientWidth,
    };
  });
}

test.describe("the top bar on a phone", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "mobile", "phone widths"); });
  for (const width of [375, 393, 430]) {
    for (const who of [{ admin: true, dark: true }, { admin: false, dark: false }]) {
      test(`is one row at ${width} px for ${who.admin ? "an admin (dark)" : "a member (light)"}, with a long balance`, async ({ page }) => {
        await page.setViewportSize({ width, height: 852 });
        await open(page, "/wallet", { ...who, balance: -1234 });
        const row = await barRow(page);
        expect(Math.max(...row.tops) - Math.min(...row.tops), `the bar wrapped: tops ${row.tops.join(", ")}`).toBeLessThanOrEqual(8);
        expect(row.height, `the bar is ${row.height} px tall`).toBeLessThanOrEqual(64);
        expect(row.overflow, "the bar's row overflows sideways").toBeLessThanOrEqual(1);
      });
    }
  }
});

test.describe("the booking grid fills the room and scrolls itself", () => {
  for (const size of [{ width: 393, height: 852, project: "mobile" }, { width: 1440, height: 900, project: "desktop" }]) {
    test(`at ${size.width} × ${size.height}, the page holds still while the grid scrolls`, async ({ page }, info) => {
      test.skip(info.project.name !== size.project, "one size per project");
      await page.setViewportSize({ width: size.width, height: size.height });
      await open(page, `/bookings?date=${DAY}`);
      await page.waitForSelector('[role="grid"] button[aria-label^="Book "]');
      // Let the fill measure settle (one frame after the last layout change). The grid fills the
      // FIRST screen — its foot lands on <main>'s visible foot (above the tab bar). The games
      // detail lies under the grid since the rail went, so <main> has that much more below it;
      // what must hold is that the grid is whole on the first screen and scrolls by itself.
      await expect.poll(() => page.evaluate(() => {
        const main = document.querySelector<HTMLElement>("main#main-content")!;
        const grid = document.querySelector<HTMLElement>("[data-grid-scroller]")!;
        const foot = main.getBoundingClientRect().top + main.clientHeight - (parseFloat(getComputedStyle(main).paddingBottom) || 0);
        return Math.round(grid.getBoundingClientRect().bottom - foot);
      })).toBeLessThanOrEqual(1);
      const result = await page.evaluate(async () => {
        const main = document.querySelector<HTMLElement>("main#main-content")!;
        const grid = document.querySelector<HTMLElement>("[data-grid-scroller]")!;
        const before = { grid: grid.scrollHeight > grid.clientHeight, gridHeight: grid.clientHeight };
        const pageScroll: number[] = [];
        for (let i = 0; i < 4; i++) {
          grid.scrollTop += 200;
          await new Promise((r) => setTimeout(r, 50));
          pageScroll.push(main.scrollTop + window.scrollY);
        }
        return {
          ...before, pageScroll, overscroll: getComputedStyle(grid).overscrollBehaviorY,
          doc: document.scrollingElement!.scrollHeight - window.innerHeight,
        };
      });
      expect(result.doc, "the document scrolls").toBeLessThanOrEqual(1);
      expect(result.grid, "the grid has nothing to scroll").toBe(true);
      expect(result.gridHeight, "the grid was squeezed below its floor").toBeGreaterThanOrEqual(280);
      expect(result.pageScroll, "scrolling the grid moved the page").toEqual([0, 0, 0, 0]);
      expect(result.overscroll).toBe("contain");
    });
  }

  test("on a landscape phone the grid keeps its 280 px floor and only then does the page scroll", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "one run");
    await page.setViewportSize({ width: 844, height: 360 });
    await open(page, `/bookings?date=${DAY}`);
    await page.waitForSelector('[role="grid"] button[aria-label^="Book "]');
    const height = await page.locator("[data-grid-scroller]").evaluate((el) => el.clientHeight);
    expect(height).toBeGreaterThanOrEqual(280);
  });
});

test("a page the nav names keeps its h1 for screen readers but paints none", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await open(page, `/bookings?date=${DAY}`);
  const heading = page.getByRole("heading", { level: 1, name: "Bookings" });
  await expect(heading).toHaveCount(1);
  const painted = await heading.evaluate((el) => el.getBoundingClientRect().width > 2);
  expect(painted, "the title is still painted").toBe(false);
  // Its actions stay: the refresh button is on screen.
  await expect(page.locator("[data-page-actions]").first()).toBeVisible();
});

test("the maker's line sits at the foot of the sign-in screen, clear of the form, and only there", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await serveApi(page, [{ path: "/api/v1/whoami", body: SESSION_ANON }]);
  await page.goto("/login");
  const line = page.locator("[data-maker-line]");
  await expect(line).toBeVisible();
  await expect(line.getByRole("link", { name: "FrostAura" })).toHaveAttribute("href", "https://frostaura.net");
  const geometry = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-maker-line]")!.getBoundingClientRect();
    const card = document.querySelector<HTMLElement>("[data-auth-shell]")!.getBoundingClientRect();
    const main = document.querySelector<HTMLElement>("main")!;
    return { gapToCard: el.top - card.bottom, footGap: main.getBoundingClientRect().bottom - el.bottom, scroll: main.scrollHeight - main.clientHeight };
  });
  expect(geometry.gapToCard, "the line overlaps the form").toBeGreaterThanOrEqual(0);
  // At the very foot when the page is short enough to leave room: nothing below it but the page's edge.
  if (geometry.scroll <= 1) expect(geometry.footGap).toBeLessThanOrEqual(1);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await open(page, "/my-code");
  await expect(page.locator("[data-maker-line]")).toHaveCount(0);
});
