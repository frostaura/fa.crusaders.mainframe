import { type Page } from "@playwright/test";
import { serveApi, signIn, test, expect } from "./fixtures";
import { BOOKING, detailFixture, memberShellRoutes } from "./playersKit";

/**
 * Review round 3 — the shell and the admin section bar, at the widths and text sizes the visual
 * and accessibility lenses measured.
 *
 * <ul>
 *   <li><b>V-11</b> — at 768 (the first width with the inline nav) an admin's top bar wrapped the
 *   credits chip and the avatar onto a second row, with 20 px of the row to spare elsewhere.</li>
 *   <li><b>V-16 / X-10</b> — at 390 with 200 % text the section bar broke its own name mid-word
 *   ("Overvie / w", "HARDWA / RE"), because the count badge and the caret sat beside the words
 *   and left them 110 px; and the Admin tab's count sat on the shield it counts for.</li>
 * </ul>
 */

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

function overlap(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return w * h;
}

/** `wide`: the widest figures the top bar has to hold — a five-figure balance, "99+" and a 2-digit bell. */
async function openAdmin(page: Page, path: string, width: number, bigText = false, wide = false) {
  await page.setViewportSize({ width, height: 900 });
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: wide ? { critical: 140 } : { critical: 14, error: 9, warning: 23 } } },
    ...memberShellRoutes({
      unread: wide ? 42 : 3,
      admin: true,
      ...(wide ? { wallet: { balance_credits: 12_500, held_credits: 0, spendable_credits: 12_500, held_until: null } } : {}),
    }),
  ]);
  await page.goto(path);
  if (bigText) await page.addStyleTag({ content: "html { font-size: 32px; }" });
  await expect(page.locator("nav[data-primary-nav]")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** Every word of the element's text, and how many line boxes each one was laid out on. */
async function wordLines(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((els) => els.flatMap((el) => {
    const out: { word: string; lines: number }[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent ?? "";
      for (const m of text.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(n, m.index!);
        range.setEnd(n, m.index! + m[0].length);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        out.push({ word: m[0], lines: tops.size });
      }
    }
    return out;
  }));
}

test.describe("V-11 — the admin top bar at 768", () => {
  for (const width of [768, 1024, 1280]) {
    test(`is one row at ${width}`, async ({ page }) => {
      await openAdmin(page, "/admin", width, false, true);
      await expect(page.locator("[data-attention-badge]")).toBeVisible();
      const rows = await page.locator("[data-app-header] > div").evaluate((row) => {
        const kids = [...row.children].filter((c) => (c as HTMLElement).offsetParent !== null || getComputedStyle(c).position === "fixed");
        return kids.map((c) => {
          const r = c.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), mid: Math.round((r.top + r.bottom) / 2) };
        });
      });
      const mids = rows.map((r) => r.mid);
      expect(Math.max(...mids) - Math.min(...mids), `row items: ${JSON.stringify(rows)}`).toBeLessThanOrEqual(4);
      const over = await page.locator("[data-app-header]").evaluate((h) => h.scrollWidth - h.clientWidth);
      expect(over).toBeLessThanOrEqual(0);
    });
  }
});

test.describe("V-16 / X-10 — 200 % text on a 390 px phone", () => {
  for (const path of ["/admin", "/admin/monitoring/devices", "/admin/members"]) {
    test(`the section bar never breaks a word (${path})`, async ({ page }) => {
      await openAdmin(page, path, 390, true);
      const bar = page.locator("[data-admin-section-bar] button").first();
      await expect(bar).toBeVisible();
      const words = await wordLines(page, "[data-admin-section-bar] button");
      expect(words.length).toBeGreaterThan(1);
      for (const w of words) expect(w.lines, `"${w.word}" is broken across lines`).toBe(1);
      const m = await bar.evaluate((el) => ({ over: el.scrollWidth - el.clientWidth, right: el.getBoundingClientRect().right }));
      expect(m.over).toBeLessThanOrEqual(1);
      expect(m.right).toBeLessThanOrEqual(390);
      // The count is still on the bar.
      await expect(page.locator("[data-admin-section-bar] [data-admin-badge='total']")).toBeVisible();
    });
  }

  test("the Admin tab's count leaves its shield visible", async ({ page }) => {
    await openAdmin(page, "/admin", 390, true);
    const badge = page.locator("[data-attention-badge]");
    await expect(badge).toBeVisible();
    const icon = await page.locator("nav[data-primary-nav] a[href='/admin'] svg").first().evaluate((el) => el.getBoundingClientRect().toJSON() as Box);
    const b = await badge.evaluate((el) => el.getBoundingClientRect().toJSON() as Box);
    expect(overlap(icon, b) / (icon.width * icon.height), "share of the Admin icon under its count").toBeLessThanOrEqual(0.1);
    expect(b.right, "the count stays on the screen").toBeLessThanOrEqual(390);
  });
});

test("X-9 — a booking opened straight from a link names the booking in the tab, without taking focus", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [
    { path: `/api/v1/bookings/${BOOKING}`, body: detailFixture() },
    ...memberShellRoutes(),
  ]);
  await page.goto(`/bookings/${BOOKING}`);
  const heading = page.locator("#main-content h1");
  await expect(heading).not.toHaveText(/^Booking$/);
  const name = (await heading.textContent())!.trim();
  await expect(page).toHaveTitle(`${name} — Booking — Crusaders Mainframe`);
  await expect(heading).not.toBeFocused();
  await expect(page.getByTestId("route-announcer")).toHaveText("");
});
