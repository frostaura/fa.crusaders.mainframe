import type { Page } from "@playwright/test";
import { MEMBER_CODE, SESSION_ANON, memberCodeSecretB64, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { HEIGHT, WIDTHS, bigText, box, fontsReady, sideways, textOffScreen, widthUsed, type Width } from "./layoutKit";

/**
 * The member screens' form-factor layouts (R4, SPEC 3), measured in Chromium at
 * 390/768/1024/1280/1920 and at 390 with 200 % text: each screen uses the width it has instead of
 * centring a phone column on a desktop, and stays 100 % usable on a phone.
 *
 * <p>
 * The width sweep runs on the desktop project only (it sets its own viewport); the phone checks
 * run on both projects.
 * </p>
 */
const SESSION_MEMBER = { ...SESSION_ANON, user_id: "00000000-0000-0000-0000-000000000009", is_authenticated: true };
const PROFILE = { user_id: SESSION_MEMBER.user_id, email: "nomsa@club.test", full_name: "Nomsa Khumalo", photo_url: null, status: "active", is_admin: false, tenant_slug: "crusaders", membership_number: "M-1" };

function baseRoutes(): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_MEMBER },
    { path: "/api/v1/wallet", body: { balance_credits: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { path: "/api/v1/me/profile", body: PROFILE },
    { path: "/api/v1/me/preferences", body: {} },
    { path: "/api/v1/webauthn/credentials", body: [] },
  ];
}

function myCodeRoutes(): ApiRoute[] {
  return [
    ...baseRoutes(),
    {
      method: "POST", path: "/api/v1/me/code/enrol",
      respond: () => ({ v: 1, ref: MEMBER_CODE.ref, generation: 1, secret: memberCodeSecretB64(), tz: MEMBER_CODE.tz, step_seconds: 30, server_time_ms: Date.now() }),
    },
    { path: "/api/v1/me/code", respond: () => ({ v: 1, ref: MEMBER_CODE.ref, generation: 1, tz: MEMBER_CODE.tz, server_time_ms: Date.now() }) },
    { path: "/api/v1/me/door", body: { doors: false, doors_shut: "none", timezone: "Africa/Johannesburg", policy: "active_member", membership: "active", membership_detail: "active", is_club_admin: false, next_booking: null, early_entry_minutes: null, roster_max_entries: 48, contact: { phone: "021 555 0134", email: null }, door_log_retention_days: 90, last_decision: null } },
  ];
}

async function open(page: Page, path: string, routes: ApiRoute[], width: Width) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height: HEIGHT[width] });
  await signIn(page);
  await serveApi(page, routes);
  await page.goto(path);
  await fontsReady(page);
}

async function healthy(page: Page) {
  expect(await sideways(page), "nothing scrolls sideways").toBeLessThanOrEqual(0);
  expect(await textOffScreen(page), "no text paints off screen").toEqual([]);
}

test.describe("My Code (SPEC 3.2)", () => {
  for (const width of WIDTHS) {
    test(`${width}px: the pass first; beside the rest from a 60rem page; three columns from 72rem`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop", "one project sweeps the widths");
      await open(page, "/my-code", myCodeRoutes(), width);
      await expect(page.getByRole("article", { name: "Your member pass" })).toBeVisible();
      await healthy(page);
      const shell = (await box(page, "[data-page-shell]"))!;
      const inner = shell.width - (width >= 1800 ? 96 : width >= 1024 ? 64 : width >= 640 ? 48 : 32);
      const pass = (await box(page, "[data-my-code-pass]"))!;
      const rest = (await box(page, "[data-my-code-rest]"))!;
      const side = (await box(page, "[data-my-code-side]"))!;
      if (inner >= 60 * 16) {
        expect(rest.x, "the rest stands beside the pass").toBeGreaterThanOrEqual(pass.right);
        expect(Math.abs(rest.y - pass.y)).toBeLessThan(4);
        await expect(page.getByRole("group", { name: "Your wallet" })).toBeVisible();
      } else {
        expect(rest.y, "stacked under the pass").toBeGreaterThanOrEqual(pass.bottom);
        await expect(page.getByRole("group", { name: "Your wallet" })).toBeHidden();
      }
      if (inner >= 72 * 16) expect(side.y).toBeLessThan(rest.y + 4);
      if (width >= 1280) expect(await widthUsed(page)).toBeGreaterThanOrEqual(width >= 1800 ? 0.6 : 0.7);
    });
  }

  test("390 at 200 % text: one column, the pass on top, nothing off screen", async ({ page }) => {
    await open(page, "/my-code", myCodeRoutes(), 390);
    await expect(page.getByRole("article", { name: "Your member pass" })).toBeVisible();
    await bigText(page);
    await healthy(page);
    const pass = (await box(page, "[data-my-code-pass]"))!;
    const rest = (await box(page, "[data-my-code-rest]"))!;
    expect(rest.y).toBeGreaterThanOrEqual(pass.bottom);
  });
});
