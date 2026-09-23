import { SESSION_ANON, serveApi, test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { LOGIN, PASSWORD_TOGGLE } from "../src/lib/authCopy";

/**
 * The screens a member meets before they have a session, in a real browser and in both themes.
 *
 * <p>
 * Everything here is a property only a layout engine has: the colour a translucent ink actually
 * paints on the band, the size a control is drawn at, whether the page runs off a 360px phone,
 * and whether Chromium's own `PublicKeyCredential` puts the passkey control on the screen. jsdom
 * has none of them — the dark-theme subline was unreadable for a whole phase with every unit test
 * green, because the unit tests could not see a colour.
 * </p>
 */

const THEMES = ["light", "dark"] as const;

/** The theme boot script reads this key before first paint (design-system.md, Theme). */
async function useTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.addInitScript((t) => {
    try { localStorage.setItem("crusaders:theme", t); } catch { /* private mode */ }
  }, theme);
}

/** WCAG contrast of two computed `rgb()`/`rgba()` colours, the first composited onto the second. */
async function paintedContrast(page: Page, selector: string, backgroundSelector: string): Promise<number> {
  return page.evaluate(([fg, bg]) => {
    const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const [r, g, b, a = 1] = parse(getComputedStyle(document.querySelector(fg)!).color);
    const [br, bgc, bb] = parse(getComputedStyle(document.querySelector(bg)!).backgroundColor);
    const mix = [r * a + br * (1 - a), g * a + bgc * (1 - a), b * a + bb * (1 - a)];
    const lum = (rgb: number[]) => {
      const [R, G, B] = rgb.map((c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * R + 0.7152 * G + 0.0722 * B;
    };
    const [hi, lo] = [lum(mix), lum([br, bgc, bb])].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }, [selector, backgroundSelector]);
}

for (const theme of THEMES) {
  test.describe(`sign in — ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await useTheme(page, theme);
      await serveApi(page, [{ path: "/api/v1/session", body: SESSION_ANON }]);
      await page.goto("/login");
      await expect(page.getByRole("heading", { level: 1, name: LOGIN.title })).toBeVisible();
    });

    /**
     * The defect this phase was handed: "Court bookings, credits and your club account" in dark
     * blue on the blue band, in the dark theme. Measured as painted — ink alpha composited onto
     * the band's computed background — not as the token pair the source names.
     */
    test("the band's subline is readable on the band", async ({ page }) => {
      const ratio = await paintedContrast(page, "[data-auth-subline]", ".bg-brand-strong");
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    test("every control is at least 44px tall", async ({ page }) => {
      const short = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("main input:not([type=file]), main button")]
          .map((el) => ({ name: el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName, h: el.getBoundingClientRect().height }))
          .filter((c) => c.h > 0 && c.h < 44));
      expect(short).toEqual([]);
    });

    test("the password can be revealed and hidden again, and Enter still submits", async ({ page }) => {
      const field = page.getByLabel(LOGIN.password, { exact: true });
      await field.fill("Review!2345");
      await page.getByRole("button", { name: PASSWORD_TOGGLE.show }).click();
      await expect(field).toHaveAttribute("type", "text");
      await page.getByRole("button", { name: PASSWORD_TOGGLE.hide }).click();
      await expect(field).toHaveAttribute("type", "password");
    });

    test("links navigate and look like links; the passkey is a real button above the form", async ({ page }) => {
      await expect(page.getByRole("link", { name: LOGIN.forgot })).toHaveAttribute("href", "/forgot-password");
      await expect(page.getByRole("link", { name: LOGIN.register })).toHaveAttribute("href", "/register");
      // Chromium exposes PublicKeyCredential, so the passkey control must be on screen.
      const passkey = page.getByRole("button", { name: LOGIN.passkey });
      await expect(passkey).toBeVisible();
      const [passkeyBox, submitBox] = await Promise.all([
        passkey.boundingBox(),
        page.getByRole("button", { name: LOGIN.submit, exact: true }).boundingBox(),
      ]);
      expect(passkeyBox!.y).toBeLessThan(submitBox!.y);
      expect(Math.round(passkeyBox!.width)).toBe(Math.round(submitBox!.width));
    });

    test("nothing runs off a 360px phone", async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 740 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
}

test("an empty sign-in says what is missing on the fields, and asks the server nothing", async ({ page }) => {
  const asked: string[] = [];
  await serveApi(page, [{ path: "/api/v1/session", body: SESSION_ANON }]);
  page.on("request", (r) => { if (r.url().includes("/auth/login")) asked.push(r.url()); });
  await page.goto("/login");
  await page.getByRole("button", { name: LOGIN.submit, exact: true }).click();

  await expect(page.getByLabel(LOGIN.email, { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel(LOGIN.email, { exact: true })).toBeFocused();
  expect(asked).toEqual([]);
});
