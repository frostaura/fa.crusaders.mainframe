import { serveApi, signIn, test, expect } from "./fixtures";
import { bigText, fontsReady } from "./layoutKit";
import { memberShellRoutes } from "./playersKit";

/**
 * Review round 7 (FD1's ask to FD2, L6-16 remainder) — the inbox row's glyphs grow with the text.
 * At 200 % the type icon and the trailing caret stayed 20 / 16 px beside doubled words.
 */

test.describe.configure({ timeout: 120_000 });

const AT = new Date(Date.now() - 5 * 60_000).toISOString();
const NOTICE = { id: "n1", kind: "players.invited", headline: "Sam asked you to play — Court 1", link: "/bookings/b1", booking_id: "b1", created_at: AT, read_at: null };

const svgWidth = (page: import("@playwright/test").Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => Math.round(el.getBoundingClientRect().width));

test.describe("L6-16 — the inbox row's icons at 200 %", () => {
  test.beforeEach(({ browserName }, info) => { void browserName; test.skip(info.project.name !== "desktop", "widths are set per test"); });

  test("390: the type icon is 20px at 100 % and doubles; the caret is 16 and doubles where it stands", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await serveApi(page, [
      ...memberShellRoutes({ unread: 1 }),
      { path: "/api/v1/me/notifications", body: { items: [NOTICE], unread_count: 1, next_cursor: null } },
    ]);
    await page.goto("/inbox");
    const row = page.locator("li", { hasText: "Sam asked you to play" }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await fontsReady(page);
    const kind = "li:has-text('Sam asked you to play') svg >> nth=0";
    const caret = "li:has-text('Sam asked you to play') svg >> nth=-1";
    expect(await svgWidth(page, kind)).toBe(20);
    expect(await svgWidth(page, caret)).toBe(16);
    await bigText(page);
    expect(await svgWidth(page, kind), "the type icon stayed 20px at a 32px root").toBeGreaterThanOrEqual(36);
    // The caret folds away while the row is under 17rem (a 390 phone at 200 %); where it stands, it grows.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator(caret)).toBeVisible();
    expect(await svgWidth(page, caret), "the caret stayed 16px").toBeGreaterThanOrEqual(28);
  });
});
