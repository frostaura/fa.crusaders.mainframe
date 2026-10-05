import { type Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { BOOKING, detailFixture, memberShellRoutes } from "./playersKit";
import { BUY_COPY } from "../src/lib/topUpShelf";

/**
 * Review round 15, lane FE15m — layout, measured in Chromium.
 *
 * <ul>
 *   <li><b>L15-6</b> — at 200 % the account menu's rem-sized avatar (64px) overflowed its 44px
 *   button and the app bar. It never outgrows its button now.</li>
 *   <li><b>L15-7</b> — at 56rem the booking page is two columns under a Players block that spans
 *   both; the teams' 16px gap against the page's 32px left Team B 8px off the column under it.</li>
 *   <li><b>L15-8</b> — /wallet/buy at 320 / 200 %: the disabled pay bar was four lines (~300px)
 *   of "Pick a package to see what you pay." in a large button.</li>
 * </ul>
 */

test.describe.configure({ timeout: 120_000 });

async function large(page: Page, root: number) {
  if (root !== 16) await page.addStyleTag({ content: `html { font-size: ${root}px; }` });
  await page.evaluate(() => document.fonts.ready);
}

for (const [width, root] of [[320, 32], [390, 32], [768, 32], [1280, 32], [390, 16]] as const) {
  test(`L15-6 — the header avatar stays inside its button and the bar at ${width} / ${root * 100 / 16} %`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);
    await serveApi(page, memberShellRoutes());
    await page.goto("/my-code", { timeout: 90_000 });
    await large(page, root);
    const trigger = page.getByRole("button", { name: "Account menu" });
    await expect(trigger).toBeVisible();
    const m = await trigger.evaluate((button) => {
      const b = button.getBoundingClientRect();
      const a = button.querySelector("[data-slot=avatar]")!.getBoundingClientRect();
      const bar = button.closest("header")!.getBoundingClientRect();
      return { b: [b.left, b.top, b.right, b.bottom], a: [a.left, a.top, a.right, a.bottom, a.width, a.height], bar: [bar.top, bar.bottom] };
    });
    const [bl, bt, br, bb] = m.b;
    const [al, at, ar, ab, aw, ah] = m.a;
    expect(al).toBeGreaterThanOrEqual(bl - 0.5);
    expect(ar).toBeLessThanOrEqual(br + 0.5);
    expect(at).toBeGreaterThanOrEqual(bt - 0.5);
    expect(ab).toBeLessThanOrEqual(bb + 0.5);
    expect(ab).toBeLessThanOrEqual(m.bar[1] + 0.5);
    expect(Math.abs(aw - ah), "still a circle").toBeLessThanOrEqual(0.5);
  });
}

test("L15-7 — at 56rem Team B starts on the column under it", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop geometry");
  await page.setViewportSize({ width: 1100, height: 900 });
  await signIn(page);
  await serveApi(page, [{ path: `/api/v1/bookings/${BOOKING}`, body: detailFixture() }, ...memberShellRoutes()] as ApiRoute[]);
  await page.goto(`/bookings/${BOOKING}`, { timeout: 90_000 });
  await expect(page.locator("[data-players-section] li[data-seat]").first()).toBeVisible();
  const m = await page.evaluate(() => {
    const players = document.querySelector("[data-players-section]")!;
    const grid = players.parentElement!;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean);
    const teams = [...players.querySelectorAll("h3")].filter((h) => /^Team/.test(h.textContent ?? ""));
    const teamB = teams[1].parentElement!.getBoundingClientRect().left;
    const centre = grid.getBoundingClientRect().left + grid.getBoundingClientRect().width / 2;
    const second = [...grid.children].map((c) => c.getBoundingClientRect().left).filter((l) => l > centre);
    return { cols: cols.length, teamB, second: second.length ? Math.min(...second) : null };
  });
  expect(m.cols, "the page is two columns here").toBe(2);
  expect(m.second).not.toBeNull();
  expect(Math.abs(m.teamB - m.second!)).toBeLessThanOrEqual(1);
});

const pkg = (id: string, name: string, minutes: number, price: number) => ({
  id, name, minutes, list_price_zar: price, discount_bps: 0, price_zar: price, saving_zar: null, saving_pct: null, source: "club", group: null,
});

test("L15-8 — /wallet/buy at 320 / 200 %: the bar before a pick is one short line", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/minutes/packages", body: { discount: null, packages: [pkg("p-1", "1 hour", 60, 120), pkg("p-5", "5 hours", 300, 550)], open_checkouts: [] } },
    ...memberShellRoutes(),
  ] as ApiRoute[]);
  await page.goto("/wallet/buy", { timeout: 90_000 });
  await large(page, 32);
  const button = page.getByRole("button", { name: BUY_COPY.pickShort });
  await expect(button).toBeDisabled();
  const m = await button.evaluate((b) => {
    const bar = b.closest("[data-context-bar]")!.getBoundingClientRect();
    const r = b.getBoundingClientRect();
    const line = parseFloat(getComputedStyle(b).lineHeight);
    return { bar: bar.height, button: r.height, line, top: bar.top, vh: innerHeight };
  });
  // One line of text in the button (its height less padding is under two lines).
  expect(m.button).toBeLessThan(m.line * 2 + 40);
  expect(m.bar, "the bar leaves the page most of a 320 / 200 % screen").toBeLessThan(m.vh * 0.25);
});
