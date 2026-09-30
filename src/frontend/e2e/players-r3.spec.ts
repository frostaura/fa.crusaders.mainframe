import { type Page } from "@playwright/test";
import { serveApi, signIn, test, expect } from "./fixtures";
import { memberShellRoutes } from "./playersKit";
import { myPlayFixture } from "./playKit";

/**
 * Review round 3, lane F2 — layout at 200 % text on a 390 px phone (html font-size 32 px), and
 * at 100 % for the stacking the fix must keep.
 *
 * - V-2 / X-3: Profile's empty goal card had `min-w-48` (12rem) on its sentence — 384 px at 200 %,
 *   wider than the card — so the sentence ran out of the card and the page scrolled sideways.
 * - X-4 (member part): /inbox "Mark all read" did not wrap and ran 13 px past the screen.
 */

async function open(page: Page, path: string, bigText: boolean) {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/me/play", body: myPlayFixture({ ring: null }) },
    { path: "/api/v1/me/webauthn/credentials", body: [] },
    { path: "/api/v1/me/preferences", body: { findable: false, show_in_leaderboards: false } },
    { path: "/api/v1/me/door/history", body: { items: [], next_cursor: null } },
    {
      path: "/api/v1/me/notifications",
      body: {
        items: [{ id: "n1", kind: "players.reminder", headline: "Your share for Friday is still open", link: null, booking_id: "b2", created_at: new Date().toISOString(), read_at: null }],
        unread_count: 1, next_cursor: null,
      },
    },
    ...memberShellRoutes({ unread: 1 }),
  ]);
  await page.goto(path);
  if (bigText) await page.addStyleTag({ content: "html { font-size: 32px; }" });
  await expect(page.locator("nav[data-primary-nav]")).toBeVisible();
}

/** The page's scroller and the document: neither may scroll sideways. */
async function sideways(page: Page): Promise<number> {
  return page.evaluate(() => {
    const main = document.querySelector("#main-content") as HTMLElement | null;
    const doc = document.scrollingElement as HTMLElement;
    return Math.max(doc.scrollWidth - doc.clientWidth, main ? main.scrollWidth - main.clientWidth : 0);
  });
}

test.describe("R3 F2 — 200 % text on a phone", () => {
  test("V-2 / X-3: the empty goal card keeps its sentence inside the card, and Profile does not scroll sideways", async ({ page }) => {
    await open(page, "/profile", true);
    const card = page.locator("[data-ring='none']");
    await expect(card).toBeVisible();
    const m = await card.evaluate((el) => {
      const c = el.getBoundingClientRect();
      const p = (el.querySelector("p") as HTMLElement).getBoundingClientRect();
      return { cardRight: c.right, pRight: p.right, pLeft: p.left, cardLeft: c.left };
    });
    expect(m.pRight, "the sentence's right edge").toBeLessThanOrEqual(m.cardRight + 0.5);
    expect(m.pLeft).toBeGreaterThanOrEqual(m.cardLeft - 0.5);
    await expect.poll(() => sideways(page), { message: "sideways scroll", timeout: 5000 }).toBeLessThanOrEqual(1);
  });

  test("X-4: Inbox's 'Mark all read' wraps inside the screen", async ({ page }) => {
    await open(page, "/inbox", true);
    const button = page.getByRole("button", { name: "Mark all read" });
    await expect(button).toBeVisible();
    const m = await button.evaluate((el) => ({ over: el.scrollWidth - el.clientWidth, right: el.getBoundingClientRect().right, vw: window.innerWidth }));
    expect(m.over).toBeLessThanOrEqual(1);
    expect(m.right).toBeLessThanOrEqual(m.vw);
    await expect.poll(() => sideways(page), { message: "sideways scroll", timeout: 5000 }).toBeLessThanOrEqual(1);
  });
});

test("V-2 at 100 %: the empty goal card still stacks — button under a sentence of three lines or fewer", async ({ page }) => {
  await open(page, "/profile", false);
  const card = page.locator("[data-ring='none']");
  await expect(card).toBeVisible();
  const m = await card.evaluate((el) => {
    const p = el.querySelector("p") as HTMLElement;
    const lh = parseFloat(getComputedStyle(p).lineHeight);
    const button = (el.querySelector("button") as HTMLElement).getBoundingClientRect();
    return { lines: Math.round(p.getBoundingClientRect().height / lh), buttonTop: button.top, pBottom: p.getBoundingClientRect().bottom };
  });
  expect(m.lines).toBeLessThanOrEqual(3);
  expect(m.buttonTop).toBeGreaterThanOrEqual(m.pBottom - 1);
});
