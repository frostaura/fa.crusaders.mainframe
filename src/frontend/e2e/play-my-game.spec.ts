import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes } from "./playersKit";
import { celebrationFixture, myPlayFixture } from "./playKit";

/**
 * P12 — "My game" on Profile and the one-shot celebration (`play.md` §9.1, §9.3) in a real
 * browser: the section comes first with the ring, the streak strip, the figures and the badges;
 * a new badge is celebrated once — never over My Code — and never again after it is dismissed.
 */

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function open(page: Page, options: { theme?: "light" | "dark"; extra?: ApiRoute[] } = {}) {
  await signIn(page);
  if (options.theme) await page.addInitScript((t) => window.localStorage.setItem("crusaders:theme", t), options.theme);
  await serveApi(page, [
    ...(options.extra ?? []),
    { path: "/api/v1/me/play", body: myPlayFixture() },
    { path: "/api/v1/me/webauthn/credentials", body: [] },
    { path: "/api/v1/me/preferences", body: { findable: false, show_in_leaderboards: false } },
    { path: "/api/v1/me/door/history", body: { items: [], next_cursor: null } },
    ...memberShellRoutes(),
  ]);
}

test.describe("My game", () => {
  test("is the first section on Profile, with the ring, the streak, the figures and the badges", async ({ page }) => {
    await open(page);
    await page.goto("/profile");
    const region = page.getByRole("region", { name: "My game" });
    await expect(region).toBeVisible();
    await expect(region).toContainText("Only you can see this.");
    // First: nothing on Profile comes before it.
    const first = await page.locator("[data-my-game], [role=region]").first().getAttribute("id");
    expect(first).toBe("my-game");

    await expect(region.getByRole("img", { name: "6 hours 45 minutes on court this month, of a goal of 10 hours" })).toBeVisible();
    await expect(region.getByText("6-week streak")).toBeVisible();
    const strip = region.getByRole("list", { name: "The last 12 weeks, oldest first" });
    await expect(strip.getByRole("listitem")).toHaveCount(12);
    await expect(region.locator("[data-stats]")).toContainText("43 h 30 min");
    await expect(region.getByRole("button", { name: "Regular, Earned 14 Aug 2026" })).toBeVisible();
    await expect(region.getByRole("button", { name: "Centurion, 58 of 100" })).toBeVisible();
    await region.getByRole("button", { name: "Centurion, 58 of 100" }).click();
    await expect(page.getByText("Played 100 sessions.")).toBeVisible();

    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(scroll, "the page scrolls sideways").toBeLessThanOrEqual(0);
  });

  /**
   * P10 walk — five stat tiles left an orphan cell (2 + 2 + 1 on a phone, 3 + 2 + a hole on a
   * wide screen), and badge tiles were as tall as their own names. Every row of stats now ends at
   * the grid's right edge, and every badge tile is the same height.
   */
  test("fills every row of stats, and keeps badge tiles one height", async ({ page }) => {
    await open(page);
    await page.goto("/profile");
    const region = page.getByRole("region", { name: "My game" });
    await expect(region.locator("[data-stats]")).toBeVisible();
    const grid = (await region.locator("[data-stats]").boundingBox())!;
    const rows = new Map<number, number>();
    for (const tile of await region.locator("[data-stat]").all()) {
      const box = (await tile.boundingBox())!;
      const top = Math.round(box.y);
      rows.set(top, Math.max(rows.get(top) ?? 0, box.x + box.width));
    }
    for (const [top, right] of rows) expect(Math.abs(right - (grid.x + grid.width)), `row at ${top}`).toBeLessThanOrEqual(1);

    const heights = new Set<number>();
    for (const tile of await region.locator("[data-badges] li").all()) heights.add(Math.round((await tile.boundingBox())!.height));
    expect([...heights]).toHaveLength(1);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`passes axe (${theme})`, async ({ page }) => {
      await open(page, { theme });
      await page.goto("/profile");
      await expect(page.getByText("6-week streak")).toBeVisible();
      const scan = await new AxeBuilder({ page }).withTags(TAGS).include("#my-game").analyze();
      expect(scan.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    });
  }
});

test.describe("the celebration", () => {
  test("shows once, never over My Code, and never again once dismissed", async ({ page }) => {
    const state = { items: [celebrationFixture()] as Record<string, unknown>[], seen: [] as string[] };
    await open(page, {
      extra: [
        { path: "/api/v1/me/play/celebrations", respond: () => ({ timezone: "Africa/Johannesburg", items: state.items }) },
        {
          method: "POST", path: "/api/v1/me/play/celebrations/seen",
          respond: ({ body }) => {
            const ids = (body as { ids: string[] }).ids;
            state.seen.push(...ids);
            state.items = state.items.filter((c) => !ids.includes(c.id as string));
            return { seen: ids.length };
          },
        },
        { path: "/api/v1/me/code", status: 503, body: { error: "unavailable" } },
      ],
    });

    await page.goto("/my-code");
    await page.waitForTimeout(500);
    await expect(page.getByRole("dialog", { name: /First win/ })).toHaveCount(0);

    await page.goto("/profile");
    const moment = page.getByRole("dialog", { name: /New badge.*First win/ });
    await expect(moment).toBeVisible();
    expect(state.seen).toEqual([]);
    await moment.getByRole("button", { name: "Keep playing" }).click();
    await expect(moment).toBeHidden();
    expect(state.seen).toEqual(["c1"]);

    await page.reload();
    await expect(page.getByText("6-week streak")).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.getByRole("dialog", { name: /First win/ })).toHaveCount(0);
  });

  test("appears at rest under reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, { extra: [{ path: "/api/v1/me/play/celebrations", body: { timezone: "Africa/Johannesburg", items: [celebrationFixture()] } }] });
    await page.goto("/profile");
    const medallion = page.locator("[data-celebration-medallion]");
    await expect(medallion).toBeVisible();
    const animation = await medallion.evaluate((el) => getComputedStyle(el).animationName);
    expect(animation).toBe("none");
  });
});
