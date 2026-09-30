import { type Page } from "@playwright/test";
import { serveApi, signIn, test, expect } from "./fixtures";
import { memberShellRoutes } from "./playersKit";
import { myPlayFixture } from "./playKit";

/**
 * F4-7 / F4-14 (review round 2, A11Y-M, VIS-M) — the shell at 200 % text on a 390 px phone.
 *
 * <p>
 * Found: the header's unread badge sat on the bell; the four-tab bar cut its labels to "My C…"
 * and "Booki…" and the Admin count covered the shield; the wallet's Overview/Activity switch and
 * Profile's "Set a monthly goal" ran off the screen; and at 375/390 (normal text) the empty goal
 * card squeezed its sentence into five or six lines beside its button.
 * </p>
 */

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

function overlap(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return w * h;
}

async function box(page: Page, selector: string): Promise<Box> {
  return page.locator(selector).first().evaluate((el) => el.getBoundingClientRect().toJSON() as Box);
}

async function open(page: Page, path: string, options: { admin?: boolean; bigText?: boolean; play?: unknown } = {}) {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/me/play", body: options.play ?? myPlayFixture() },
    { path: "/api/v1/me/webauthn/credentials", body: [] },
    { path: "/api/v1/me/preferences", body: { findable: false, show_in_leaderboards: false } },
    { path: "/api/v1/me/door/history", body: { items: [], next_cursor: null } },
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: { pending_applications: 28 } } },
    ...memberShellRoutes({ unread: 3, admin: options.admin }),
  ]);
  await page.goto(path);
  if (options.bigText) await page.addStyleTag({ content: "html { font-size: 32px; }" });
  await expect(page.locator("nav[data-primary-nav]")).toBeVisible();
}

test.describe("at 200 % text on a phone", () => {
  test("the unread badge leaves most of the bell visible", async ({ page }) => {
    await open(page, "/wallet", { bigText: true });
    await expect(page.locator("[data-unread-badge]")).toBeVisible();
    const bell = await box(page, "[data-bell-glyph]");
    const badge = await box(page, "[data-unread-badge]");
    expect(overlap(bell, badge) / (bell.width * bell.height), "share of the bell under the badge").toBeLessThanOrEqual(0.25);
  });

  test("the tab labels are whole, and a count does not sit on its icon", async ({ page }) => {
    await open(page, "/wallet", { bigText: true, admin: true });
    const labels = await page.locator("nav[data-primary-nav] [data-tab-label]").evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return { text: el.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, ellipsis: getComputedStyle(el).textOverflow === "ellipsis" };
    }));
    for (const l of labels) {
      expect(l.ellipsis, `"${l.text}" is cut`).toBe(false);
      expect(l.left, `"${l.text}" runs off the left edge`).toBeGreaterThanOrEqual(0);
      expect(l.right, `"${l.text}" runs off the right edge`).toBeLessThanOrEqual(390);
    }
    // Every word whole, and no two labels on top of each other.
    for (let i = 1; i < labels.length; i++) {
      expect(labels[i].left, `"${labels[i - 1].text}" runs into "${labels[i].text}"`).toBeGreaterThanOrEqual(labels[i - 1].right - 1);
    }
    const badge = page.locator("[data-attention-badge]");
    if (await badge.count()) {
      const icon = await page.locator("nav[data-primary-nav] a[href='/admin'] svg").first().evaluate((el) => el.getBoundingClientRect().toJSON() as Box);
      const b = await badge.evaluate((el) => el.getBoundingClientRect().toJSON() as Box);
      expect(overlap(icon, b) / (icon.width * icon.height), "share of the Admin icon under its count").toBeLessThanOrEqual(0.25);
    }
  });

  test("the wallet's two views stay on the screen", async ({ page }) => {
    await open(page, "/wallet", { bigText: true });
    const nav = page.getByRole("navigation", { name: "Wallet views" });
    await expect(nav).toBeVisible();
    const m = await nav.evaluate((el) => ({ right: el.getBoundingClientRect().right, over: el.scrollWidth - el.clientWidth, vw: window.innerWidth }));
    expect(m.over).toBeLessThanOrEqual(1);
    expect(m.right).toBeLessThanOrEqual(m.vw);
  });

  test("Profile's 'Set a monthly goal' wraps rather than running off", async ({ page }) => {
    await open(page, "/profile", { bigText: true, play: myPlayFixture({ ring: null }) });
    const button = page.getByRole("button", { name: "Set a monthly goal" });
    await expect(button).toBeVisible();
    const m = await button.evaluate((el) => ({ over: el.scrollWidth - el.clientWidth, right: el.getBoundingClientRect().right, vw: window.innerWidth }));
    expect(m.over).toBeLessThanOrEqual(1);
    expect(m.right).toBeLessThanOrEqual(m.vw);
  });
});

for (const width of [375, 390]) {
  test(`F4-14 — the empty goal card puts its button under the sentence at ${width} px`, async ({ page }) => {
    await open(page, "/profile", { play: myPlayFixture({ ring: null }) });
    await page.setViewportSize({ width, height: 844 });
    const card = page.locator("[data-ring='none']");
    await expect(card).toBeVisible();
    const m = await card.evaluate((el) => {
      const p = el.querySelector("p")!;
      const lh = parseFloat(getComputedStyle(p).lineHeight);
      const button = el.querySelector("button")!.getBoundingClientRect();
      return { lines: Math.round(p.getBoundingClientRect().height / lh), buttonTop: button.top, pBottom: p.getBoundingClientRect().bottom };
    });
    expect(m.lines, "the sentence keeps a readable measure").toBeLessThanOrEqual(3);
    expect(m.buttonTop, "the button sits under the sentence").toBeGreaterThanOrEqual(m.pBottom - 1);
  });
}
