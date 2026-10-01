import { type Locator, type Page } from "@playwright/test";
import { SESSION_ADMIN, SESSION_ANON, serveApi, signIn, test, expect, memberCodeRoutes } from "./fixtures";

/**
 * F4-5 (review round 2, A11Y-M) — forced colours (Windows High Contrast) keep every chosen state
 * visible. The finding: a checked radio card showed no indicator at all (an unchecked one showed
 * its empty circle, so "checked" looked like "nothing"), and the wallet's Overview/Activity views
 * rendered current and non-current identically. The mode discards author colours that are not
 * system colours, and the state classes outranked index.css's `Highlight` rule. Measured with
 * Chromium's own forced-colours emulation: the chosen control must paint differently from its
 * unchosen neighbour.
 * </p>
 */

async function paint(locator: Locator) {
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    return `${cs.backgroundColor}|${cs.borderTopColor}|${cs.borderTopWidth}|${cs.color}`;
  });
}

async function forced(page: Page) {
  await page.emulateMedia({ forcedColors: "active" });
}

test("a checked radio card, and its dot, differ from an unchecked one", async ({ page }) => {
  await forced(page);
  await serveApi(page, [{ path: "/api/v1/whoami", body: SESSION_ANON }, { path: "/api/v1/session", body: SESSION_ANON }]);
  await page.goto("/dev/primitives?section=fields&theme=light");
  const group = page.getByRole("radiogroup", { name: "Book as" }).first();
  await group.getByRole("radio", { name: "Book for a member" }).click();
  const checked = group.getByRole("radio", { name: "Book for a member" });
  const unchecked = group.getByRole("radio", { name: "Book for myself" });
  await expect(checked).toHaveAttribute("data-state", "checked");

  expect(await paint(checked)).not.toBe(await paint(unchecked));
  // The dot's fill is what a sighted keyboard user reads as "this one": it must be painted.
  const fill = await checked.locator("span[aria-hidden] > span").evaluate((el) => ({
    bg: getComputedStyle(el).backgroundColor, scale: getComputedStyle(el).scale, transform: getComputedStyle(el).transform,
  }));
  const surface = await checked.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(fill.bg, "the chosen dot is filled with a colour the mode keeps").not.toBe(surface);
});

test("a single-choice toggle that is on differs from one that is off", async ({ page }) => {
  await forced(page);
  await serveApi(page, [{ path: "/api/v1/whoami", body: SESSION_ANON }, { path: "/api/v1/session", body: SESSION_ANON }]);
  await page.goto("/dev/primitives?section=fields&theme=light");
  const on = page.getByRole("radio", { name: "Light" }).first();
  const off = page.getByRole("radio", { name: "Dark" }).first();
  await expect(on).toHaveAttribute("data-state", "on");
  expect(await paint(on)).not.toBe(await paint(off));
});

test("the wallet's current view differs from the other", async ({ page }) => {
  await forced(page);
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: { ...SESSION_ADMIN, is_admin: false } },
    { path: "/api/v1/me/profile", body: { full_name: "Lerato Mokoena", email: "lerato@sample.local", photo_url: null, membership_number: "M-0001" } },
    { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    ...memberCodeRoutes(),
  ]);
  await page.goto("/wallet");
  const views = page.getByRole("navigation", { name: "Wallet views" });
  const current = views.getByRole("link", { name: "Overview" });
  await expect(current).toHaveAttribute("aria-current", "page");
  expect(await paint(current)).not.toBe(await paint(views.getByRole("link", { name: "Activity" })));
});
