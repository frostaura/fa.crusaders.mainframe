import { type Locator, type Page } from "@playwright/test";
import { SESSION_ADMIN, SESSION_ANON, serveApi, signIn, test, expect, memberCodeRoutes } from "./fixtures";

/**
 * X-1 (review round 3, A11Y) — under forced colours the LABEL of a chosen control must still be
 * readable, not just the control's box.
 *
 * <p>
 * F4-5 restated each chosen state as `Highlight` behind `HighlightText`, and `e2e/forced-colors`
 * proved the chosen control PAINTS differently from its neighbour — which it did. What nobody
 * looked at was the text: with `forced-color-adjust: auto` Chromium draws a readability backplate
 * of `Canvas` behind every run of text, so `HighlightText` sat on `Canvas` — white on white in the
 * light palette, black on black in the dark one. The wallet's current view, the chosen top-up
 * amount and the chosen player-picker tab were solid blocks with no word on them.
 * </p>
 *
 * <p>
 * Measured in pixels, because computed style cannot see a backplate: the label's own text box is
 * screenshotted and its luminance range read back. A readable label has glyphs of one colour on a
 * field of another; a backplated one is a single flat colour.
 * </p>
 */

type Scheme = "light" | "dark";

async function forced(page: Page, scheme: Scheme) {
  await page.emulateMedia({ forcedColors: "active", colorScheme: scheme });
}

/** The luminance range (0–255) across the pixels of the element's own text. */
async function labelInk(page: Page, locator: Locator): Promise<number> {
  await locator.scrollIntoViewIfNeeded();
  const rect = await locator.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      left = Math.min(left, r.left); top = Math.min(top, r.top); right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
    }
    // One pixel in from every edge, so the field around the backplate is not what is measured.
    return { x: left + 1, y: top + 1, width: right - left - 2, height: bottom - top - 2 };
  });
  expect(rect.width, "the label has text to measure").toBeGreaterThan(4);
  const png = await page.screenshot({ clip: rect });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let min = 255; let max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      min = Math.min(min, l);
      max = Math.max(max, l);
    }
    return max - min;
  }, png.toString("base64"));
}

/** Readable = glyphs clearly apart from their field. A backplated label measures about 0. */
const READABLE = 60;

async function gallery(page: Page, section: string, scheme: Scheme) {
  await forced(page, scheme);
  await serveApi(page, [{ path: "/api/v1/whoami", body: SESSION_ANON }, { path: "/api/v1/session", body: SESSION_ANON }]);
  await page.goto(`/dev/primitives?section=${section}&theme=${scheme}`);
  await expect(page.locator(`[data-gallery-section="${section}"]`)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`forced colours, ${scheme} palette`, () => {
    test("a toggle that is on keeps its label readable", async ({ page }) => {
      await gallery(page, "shell", scheme);
      const on = page.getByRole("radio", { name: scheme === "dark" ? "Dark" : "Light" }).first();
      await expect(on).toHaveAttribute("data-state", "on");
      expect(await labelInk(page, on)).toBeGreaterThan(READABLE);
      // …and the one that is off stays readable too (the control, not the fix, is under test).
      const off = page.getByRole("radio", { name: "System" }).first();
      expect(await labelInk(page, off)).toBeGreaterThan(READABLE);
    });

    for (const variant of ["segmented", "underline"] as const) {
      test(`the active ${variant} tab keeps its label readable`, async ({ page }) => {
        await gallery(page, "shell", scheme);
        const active = page.getByTestId(`ui-tabs-${variant}`).getByRole("tab", { name: "Recent" });
        await expect(active).toHaveAttribute("data-state", "active");
        expect(await labelInk(page, active)).toBeGreaterThan(READABLE);
      });
    }

    test("the wallet's current view keeps its label readable", async ({ page }) => {
      await forced(page, scheme);
      await signIn(page);
      await serveApi(page, [
        { path: "/api/v1/whoami", body: { ...SESSION_ADMIN, is_admin: false } },
        { path: "/api/v1/me/profile", body: { full_name: "Lerato Mokoena", email: "lerato@sample.local", photo_url: null, membership_number: "M-0001" } },
        { path: "/api/v1/wallet", body: { balance_credits: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
        ...memberCodeRoutes(),
      ]);
      await page.goto("/wallet");
      const current = page.getByRole("navigation", { name: "Wallet views" }).getByRole("link", { name: "Overview" });
      await expect(current).toHaveAttribute("aria-current", "page");
      expect(await labelInk(page, current)).toBeGreaterThan(READABLE);
    });
  });
}
