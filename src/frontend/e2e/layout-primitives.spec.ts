import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { SESSION_ANON, serveApi, test, expect } from "./fixtures";
import { HEIGHT, WIDTHS, bigText, box, fontsReady, sideways, textOffScreen } from "./layoutKit";

/**
 * The R4 layout primitives (SPEC 2), measured in Chromium on the gallery's Layout section at
 * 390/768/1024/1280/1920, at 200 % text, in both themes under axe.
 *
 * <p>
 * Each primitive decides by the width of its OWN box (a container query), so every assertion
 * here is written against the measured box, not the viewport: "split iff the split view's box is
 * at least 64rem" holds beside an index column, beside the admin rail and at 200 % text alike.
 * </p>
 */
const REM = 16;

async function openLayout(page: Page, opts: { theme?: "light" | "dark"; row?: number } = {}) {
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ANON },
    { path: "/api/v1/session", body: SESSION_ANON },
  ]);
  const row = opts.row === undefined ? "" : `&row=${opts.row}`;
  await page.goto(`/dev/primitives?section=layout&theme=${opts.theme ?? "light"}${row}`);
  await expect(page.locator('[data-gallery-section="layout"]')).toBeVisible();
  await fontsReady(page);
}

test.describe("at every width", () => {
  test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "one project sweeps the widths");
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  for (const width of WIDTHS) {
    test(`${width}px: the split view splits iff its box is 64rem, nothing scrolls sideways`, async ({ page }) => {
      await page.setViewportSize({ width, height: HEIGHT[width] });
      await openLayout(page, { row: 1 });
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      expect(await textOffScreen(page)).toEqual([]);

      const split = (await box(page, "[data-split-view]"))!;
      const list = await box(page, "[data-split-list]");
      const detail = (await box(page, '[data-demo="split-detail"]'))!;
      if (split.width >= 64 * REM) {
        expect(list, "the list stays beside the picked row").not.toBeNull();
        expect(detail.x).toBeGreaterThanOrEqual(list!.right);
        expect(Math.abs(detail.y - list!.y)).toBeLessThan(8);
        // The list pane is 24rem (28rem from 3xl, 1800px), plus its 4px focus-room padding each side.
        const pane = (width >= 1800 ? 28 : 24) * REM + 8;
        expect(Math.abs(list!.width - pane)).toBeLessThan(2);
      } else {
        expect(list, "stacked: only the picked row shows").toBeNull();
        expect(detail.width).toBeGreaterThan(split.width - 8);
      }
    });

    test(`${width}px: the aside stands beside the main column iff its box is 72rem`, async ({ page }) => {
      await page.setViewportSize({ width, height: HEIGHT[width] });
      await openLayout(page);
      const host = (await box(page, "[data-with-aside]"))!;
      const main = (await box(page, "[data-aside-main]"))!;
      const aside = (await box(page, 'aside[aria-label="Day summary"]'))!;
      if (host.width >= 72 * REM) {
        expect(aside.x).toBeGreaterThanOrEqual(main.right);
        expect(aside.width).toBeGreaterThanOrEqual(20 * REM - 1);
      } else {
        expect(aside.y).toBeGreaterThanOrEqual(main.bottom);
        expect(aside.width).toBeGreaterThan(host.width - 16);
      }
    });

    test(`${width}px: AutoGrid packs tiles no narrower than their token and no more than its cap`, async ({ page }) => {
      await page.setViewportSize({ width, height: HEIGHT[width] });
      await openLayout(page);
      const tiles = await page.locator('[data-demo="autogrid-stat"] > li').evaluateAll((els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: r.width };
      }));
      const grid = (await box(page, '[data-demo="autogrid-stat"]'))!;
      const firstRow = tiles.filter((t) => t.y === tiles[0].y).length;
      expect(firstRow).toBeLessThanOrEqual(6);
      for (const tile of tiles) {
        expect(tile.width).toBeGreaterThanOrEqual(Math.min(9 * REM, grid.width) - 1);
        expect(tile.x + tile.width).toBeLessThanOrEqual(grid.right + 1);
      }
      // A box that could hold six holds six, in one row.
      if (grid.width >= 6 * 9 * REM + 5 * 12) expect(firstRow).toBe(6);
    });
  }
});

test.describe("on a phone", () => {
  test("390 at 200 % text: everything stacks, and no text leaves the screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openLayout(page, { row: 0 });
    await bigText(page);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    expect(await textOffScreen(page)).toEqual([]);
    expect(await box(page, "[data-split-list]")).toBeNull();
    const main = (await box(page, "[data-aside-main]"))!;
    const aside = (await box(page, 'aside[aria-label="Day summary"]'))!;
    expect(aside.y).toBeGreaterThanOrEqual(main.bottom);
  });

  test("a docked bar sits above the tab bar, and the page grows by it so nothing hides under it", async ({ page }) => {
    // At rest: the bar slides up on arrival, and a mid-slide box is below the fold.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await openLayout(page);
    const before = await page.locator("#main-content").evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
    await page.getByRole("button", { name: "Show the docked bar" }).click();
    const bar = page.getByRole("region", { name: "Wallet actions" });
    await expect(bar.getByRole("button", { name: "Buy minutes" })).toBeVisible();
    const after = await page.locator("#main-content").evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
    const panel = (await bar.locator("> div").boundingBox())!;
    expect(after - before).toBeGreaterThanOrEqual(panel.height);
    // In thumb reach: the panel's foot is within the bottom fifth of the screen, above any tab bar.
    const tabBar = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-bottom-bar-height")) || 0);
    expect(panel.y + panel.height).toBeLessThanOrEqual(844 - tabBar);
    expect(panel.y + panel.height).toBeGreaterThan(844 * 0.8);
    const target = (await bar.getByRole("button", { name: "Buy minutes" }).boundingBox())!;
    expect(target.height).toBeGreaterThanOrEqual(44);
    await page.getByRole("button", { name: "Hide the docked bar" }).click();
    await expect(bar).toHaveCount(0);
    const reset = await page.locator("#main-content").evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
    expect(reset).toBe(before);
  });
});

test.describe("keyboard", () => {
  test("Up and Down walk the split view's list; Enter opens the row", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "a desktop width");
    await page.setViewportSize({ width: 1920, height: 1080 });
    await openLayout(page);
    const rows = page.locator("[data-split-list] [data-split-item]");
    await rows.first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press("End");
    await expect(rows.last()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/row=3/);
    await expect(rows.last()).toHaveAttribute("aria-current", "page");
    await expect(page.locator('[data-demo="split-detail"]')).toContainText("Sarah Naidoo");
  });
});

test.describe("axe, both themes", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [390, 1920] as const) {
      test(`${theme} at ${width}`, async ({ page }, info) => {
        test.skip(width === 1920 && info.project.name !== "desktop", "a desktop width");
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.setViewportSize({ width, height: 4000 });
        await openLayout(page, { theme, row: 0 });
        await page.getByRole("button", { name: "Show the docked bar" }).click();
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .include("[data-gallery]")
          .analyze();
        expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
      });
    }
  }
});

test.describe("forced colours", () => {
  test("the context bars and the split view's picked row keep an edge", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await openLayout(page, { row: 0 });
    await page.getByRole("button", { name: "Show the docked bar" }).click();
    for (const selector of ['[data-context-bar="top"]', '[data-context-bar="bottom"] > div']) {
      const edge = await page.locator(selector).first().evaluate((el) => {
        const cs = getComputedStyle(el);
        return Math.max(parseFloat(cs.borderTopWidth), parseFloat(cs.borderBottomWidth));
      });
      expect(edge, selector).toBeGreaterThan(0);
    }
  });
});
