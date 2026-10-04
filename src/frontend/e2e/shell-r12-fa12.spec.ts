import { type Page } from "@playwright/test";
import { MEMBER_CODE, memberCodeSecretB64, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes } from "./playersKit";

/**
 * Review round 12 (FA12) — primitives and shell at 320 px / 200 % text.
 *
 * <ul>
 *   <li><b>L12-1</b> — the Admin tab's count ran off the screen (288–325 px of 320) with "51".</li>
 *   <li><b>L12-3</b> — /admin/results' four tabs scrolled with nothing to say "Confirmed" and
 *   "Removed" existed; the list now fades out at the edge that has more.</li>
 *   <li><b>L12-4</b> — My Code's "Open wallet" link was 16 px beside the 14 px "Buy minutes".</li>
 * </ul>
 */

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

function overlap(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return w * h;
}

async function open(page: Page, path: string, width: number, routes: ApiRoute[], big = true) {
  await page.setViewportSize({ width, height: 800 });
  await signIn(page);
  await serveApi(page, routes);
  await page.goto(path);
  if (big) await page.addStyleTag({ content: "html { font-size: 32px; }" });
  await expect(page.locator("nav[data-primary-nav]")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

function adminRoutes(critical: number): ApiRoute[] {
  return [
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: { critical } } },
    { path: "/api/v1/admin/play/results/disputed/count", body: { count: 0 } },
    { path: "/api/v1/admin/play/results", body: { items: [], next_cursor: null, count: 0 } },
    { path: "/api/v1/admin/members/", body: [] },
    ...memberShellRoutes({ admin: true }),
  ];
}

test.describe("L12-1 — the Admin count stays in its tab, on the screen and in the bar", () => {
  for (const [critical, text] of [[51, "51"], [7, "7"], [140, "99+"]] as const) {
    test(`at 320 / 200 % with "${text}"`, async ({ page }) => {
      await open(page, "/admin", 320, adminRoutes(critical));
      const badge = page.locator("[data-attention-badge]");
      await expect(badge).toHaveText(text);
      const m = await page.evaluate(() => {
        const r = (el: Element) => el.getBoundingClientRect().toJSON();
        return {
          badge: r(document.querySelector("[data-attention-badge]")!),
          tab: r(document.querySelector("nav[data-primary-nav] a[href='/admin']")!),
          icon: r(document.querySelector("nav[data-primary-nav] a[href='/admin'] svg")!),
          nav: r(document.querySelector("nav[data-primary-nav]")!),
          vw: window.innerWidth,
        };
      });
      expect(m.badge.right, "the count stays on the screen").toBeLessThanOrEqual(m.vw);
      expect(m.badge.right, "the count stays in its own tab").toBeLessThanOrEqual(m.tab.right + 0.5);
      expect(m.badge.top, "the count stays inside the bar").toBeGreaterThanOrEqual(m.nav.top);
      expect(overlap(m.icon, m.badge) / (m.icon.width * m.icon.height), "share of the shield under the count").toBeLessThanOrEqual(0.25);
    });
  }
});

test.describe("L12-3 — a scrolling tab list says there are more tabs", () => {
  test("/admin/results at 320 / 200 %: the end fades under a caret, the start once scrolled", async ({ page }) => {
    await open(page, "/admin/results", 320, adminRoutes(0));
    const list = page.getByRole("tablist");
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute("data-overflow", "end");
    const m = await list.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const caret = el.parentElement!.querySelector("[data-tabs-edge=end]")?.getBoundingClientRect();
      // A caret, not just the fade: a gap between two tabs can fall exactly on the edge ("Recent"
      // ended 7 px inside it at 320 / 200 %), leaving the fade nothing to cut.
      return {
        mask: getComputedStyle(el).maskImage,
        caret: caret ? { right: caret.right, width: caret.width, boxRight: box.right } : null,
      };
    });
    expect(m.mask).toContain("linear-gradient");
    expect(m.caret, "a caret marks the edge with more").not.toBeNull();
    expect(m.caret!.width).toBeGreaterThan(8);
    expect(Math.abs(m.caret!.right - m.caret!.boxRight)).toBeLessThanOrEqual(1);
    await expect(page.locator("[data-tabs-edge=start]")).toHaveCount(0);

    // Keyboard to the last tab: the list scrolls, the tab sits clear of the fade, and the start fades.
    await page.getByRole("tab").first().focus();
    await page.keyboard.press("End");
    const last = page.getByRole("tab").last();
    await expect(last).toBeFocused();
    await expect(list).toHaveAttribute("data-overflow", /start/);
    await expect(page.locator("[data-tabs-edge=start]")).toHaveCount(1);
    const clear = await last.evaluate((tab) => {
      const list = tab.closest("[role=tablist]")!.getBoundingClientRect();
      return list.right - tab.getBoundingClientRect().right;
    });
    expect(clear, "the focused tab is not past the edge").toBeGreaterThanOrEqual(-1);
  });

  test("a short list that fits has no fade", async ({ page }) => {
    await open(page, "/admin/results", 1280, adminRoutes(0), false);
    const list = page.getByRole("tablist");
    await expect(list).toBeVisible();
    await expect(list).not.toHaveAttribute("data-overflow");
    await expect(page.locator("[data-tabs-edge]")).toHaveCount(0);
    expect(await list.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
  });
});

test("L12-4 — My Code's 'Open wallet' is the size of 'Buy minutes' beside it", async ({ page }) => {
  await open(page, "/my-code", 1280, [
    ...memberShellRoutes(),
    { method: "POST", path: "/api/v1/me/code/enrol", respond: () => ({ v: 1, ref: MEMBER_CODE.ref, generation: 1, secret: memberCodeSecretB64(), tz: MEMBER_CODE.tz, step_seconds: 30, server_time_ms: Date.now() }) },
    { path: "/api/v1/me/code", respond: () => ({ v: 1, ref: MEMBER_CODE.ref, generation: 1, tz: MEMBER_CODE.tz, server_time_ms: Date.now() }) },
  ], false);
  const glance = page.locator("[data-my-code-side] [role=group], [role=group]").filter({ has: page.locator("a[href='/wallet'][data-text-link]") }).first();
  await expect(glance).toBeVisible();
  const sizes = await glance.evaluate((el) => ({
    link: getComputedStyle(el.querySelector("a[data-text-link]")!).fontSize,
    button: getComputedStyle(el.querySelector("a:not([data-text-link])")!).fontSize,
  }));
  expect(sizes.link).toBe(sizes.button);
});
