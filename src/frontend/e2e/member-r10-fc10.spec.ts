import { type Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { inviteFixture, memberShellRoutes } from "./playersKit";

/**
 * Review round 10, lane FC10 — the member's screens at 200 % text on a small phone (L10-6).
 *
 * <p>
 * The Wallet's Overview | Activity pill let each segment shrink below its word, so "Overview" ran
 * into the pill's edge with no inner padding at 320 / 200 %. And at 320×640 / 200 % the accept
 * sheet's three stacked actions (Cancel, Decline, Accept and pay …) took ~45 % of the screen,
 * leaving ~95 px to read the share in — Cancel only repeating the ×.
 * </p>
 */

async function open(page: Page, path: string, size: { width: number; height: number }, routes: ApiRoute[] = []) {
  await page.setViewportSize(size);
  await signIn(page);
  await serveApi(page, [...routes, ...memberShellRoutes({ invites: [inviteFixture()] })]);
  await page.addInitScript(() => {
    const add = () => { const s = document.createElement("style"); s.textContent = "html { font-size: 32px; }"; document.documentElement.appendChild(s); };
    if (document.documentElement) add(); else addEventListener("DOMContentLoaded", add);
  });
  await page.goto(path);
}

test("L10-6 — the Wallet views pill keeps its padding round each word at 320 px, 200 % text", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "sizes are set per test");
  await open(page, "/wallet", { width: 320, height: 640 });
  const nav = page.getByRole("navigation", { name: "Wallet views" });
  await expect(nav).toBeVisible();
  const gaps = await nav.evaluate((el) => [...el.querySelectorAll("a")].map((a) => {
    const range = document.createRange();
    range.selectNodeContents(a);
    const text = range.getBoundingClientRect();
    const box = a.getBoundingClientRect();
    return { label: a.textContent, left: Math.round(text.left - box.left), right: Math.round(box.right - text.right), inScreen: box.right <= innerWidth };
  }));
  for (const g of gaps) {
    expect(g.left, JSON.stringify(g)).toBeGreaterThanOrEqual(8);
    expect(g.right, JSON.stringify(g)).toBeGreaterThanOrEqual(8);
    expect(g.inScreen, JSON.stringify(g)).toBe(true);
  }
  await page.screenshot({ path: info.outputPath("wallet-nav-320.png") });
});

test("L10-6 — at 320×640, 200 % text, the accept sheet leaves room to read: no Cancel beside the ×", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "sizes are set per test");
  await open(page, "/bookings/invites", { width: 320, height: 640 });
  await page.locator("[data-card-accept]").last().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-accept]")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /close/i })).toBeVisible();
  const body = await dialog.locator("[data-slot=dialog-body]").evaluate((el) => el.getBoundingClientRect().height);
  const footer = await dialog.locator("[data-slot=dialog-footer]").evaluate((el) => el.getBoundingClientRect().height);
  expect(footer, `footer ${footer}px, body ${body}px`).toBeLessThan(640 * 0.36);
  expect(body, `footer ${footer}px, body ${body}px`).toBeGreaterThan(150);
  await page.screenshot({ path: info.outputPath("accept-320x640.png") });
});

test("L10-6 — a phone of ordinary height keeps Cancel in the accept sheet", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "sizes are set per test");
  await open(page, "/bookings/invites", { width: 390, height: 844 });
  await page.locator("[data-card-accept]").last().click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Cancel" })).toBeVisible();
});
