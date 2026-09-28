import { mkdirSync } from "node:fs";
import { SESSION_ANON, MEMBER_CODE, memberCodeSecretB64, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { expectedToken, tokensAroundNow } from "./memberCodeOracle";

/**
 * D1 in a real browser — the single rotating member code on the pass (R9), on both projects
 * (Pixel 7 and desktop Chrome): real WebCrypto, real IndexedDB, real layout.
 *
 * <p>
 * Every token asserted here is checked against `memberCodeOracle.ts`, an independent Node
 * implementation of the spec, so a page that drew a plausible 19-character string the club
 * would refuse fails.
 * </p>
 */

const SESSION_MEMBER = { ...SESSION_ANON, user_id: "00000000-0000-0000-0000-000000000009", is_authenticated: true };
/** The corpus anchor: 2026-09-23T18:00:17+02:00, 17 s into step 59672640. */
const ANCHOR_MS = 1790179217_000;
const SHOTS = process.env.P7_SHOTS_DIR;

function routes(serverTime: () => number = () => Date.now()): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_MEMBER },
    { path: "/api/v1/wallet", body: { balance_credits: 500, entries: [], total_entries: 0, offset: 0, limit: 50 } },
    { path: "/api/v1/me/profile", body: { user_id: SESSION_MEMBER.user_id, email: "nomsa@club.test", full_name: "Nomsa Khumalo", photo_url: null, status: "active", is_admin: false, tenant_slug: "crusaders", membership_number: "M-1" } },
    {
      method: "POST", path: "/api/v1/me/code/enrol",
      respond: () => ({ v: 1, ref: MEMBER_CODE.ref, generation: 1, secret: memberCodeSecretB64(), tz: MEMBER_CODE.tz, step_seconds: 30, server_time_ms: serverTime() }),
    },
    { path: "/api/v1/me/code", respond: () => ({ v: 1, ref: MEMBER_CODE.ref, generation: 1, tz: MEMBER_CODE.tz, server_time_ms: serverTime() }) },
    { path: "/api/v1/me/door", body: { doors: false, doors_shut: "none", timezone: "Africa/Johannesburg", policy: "active_member", membership: "active", membership_detail: "active", is_club_admin: false, next_booking: null, early_entry_minutes: null, roster_max_entries: 48, contact: { phone: "021 555 0134", email: null }, door_log_retention_days: 90, last_decision: null } },
    { path: "/api/v1/me/preferences", body: {} },
    { path: "/api/v1/webauthn/credentials", body: [] },
  ];
}

test("the pass carries the club's own token for now, centred, as QR and as readable groups", async ({ page }) => {
  await signIn(page);
  await serveApi(page, routes());
  await page.goto("/my-code");

  const code = page.getByLabel("Your code", { exact: true });
  await expect(code).toHaveText(/^118Y9\d{14}$/);
  const token = (await code.textContent())!;
  expect(tokensAroundNow()).toContain(token);
  await expect(page.getByRole("img", { name: `QR code ${token}` })).toBeVisible();
  // One code: no tabs.
  await expect(page.getByRole("tab")).toHaveCount(0);

  // R9 — centred in the page column at every width.
  const pass = (await page.getByRole("article", { name: "Your member pass" }).boundingBox())!;
  const column = (await page.locator("[data-page-shell]").boundingBox())!;
  const passCentre = pass.x + pass.width / 2;
  const columnCentre = column.x + column.width / 2;
  expect(Math.abs(passCentre - columnCentre)).toBeLessThanOrEqual(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the code turns over at the step boundary, on the phone, with the ring counting it down", async ({ page }) => {
  await page.clock.install({ time: ANCHOR_MS });
  await signIn(page);
  // The club's clock is the page's clock, so the measured offset is nothing and the token is
  // the corpus's own.
  await serveApi(page, routes(() => ANCHOR_MS));
  await page.goto("/my-code");

  const code = page.getByLabel("Your code", { exact: true });
  await expect(code).toHaveText(expectedToken(59672640));
  await expect(page.getByText(/^New code in \d+ seconds?$/)).toBeVisible();
  await expect(page.locator("[data-countdown-ring]")).toHaveAttribute("aria-hidden", "true");

  await page.clock.fastForward(14_000);
  await expect(code).toHaveText(expectedToken(59672641));
  expect(expectedToken(59672641)).toBe("118Y925437688407038");
});

test("losing signal keeps the code and says so with a badge", async ({ page, context }) => {
  await signIn(page);
  await serveApi(page, routes());
  await page.goto("/my-code");
  const code = page.getByLabel("Your code", { exact: true });
  await expect(code).toHaveText(/^118Y9\d{14}$/);

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByText("Offline — your code still works")).toBeVisible();
  expect(tokensAroundNow()).toContain(await code.textContent());
  await context.setOffline(false);
});

test("a first visit with no signal says the code needs it once, and draws no QR", async ({ page }) => {
  await signIn(page);
  await serveApi(page, routes());
  await page.route("**/api/v1/me/code/enrol", (route) => route.abort("failed"));
  await page.goto("/my-code");
  await expect(page.getByRole("heading", { name: "Your code needs signal the first time" })).toBeVisible();
  await expect(page.getByRole("img", { name: /QR code/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("full screen shows the same code on white, holds a wake lock, asks for brightness, and gives focus back", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __wake: string[] };
    w.__wake = [];
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: async (type: string) => {
          w.__wake.push(`request:${type}`);
          return { release: async () => { w.__wake.push("release"); } };
        },
      },
    });
  });
  await signIn(page);
  await serveApi(page, routes());
  await page.goto("/my-code");
  const code = page.getByLabel("Your code", { exact: true });
  await expect(code).toHaveText(/^118Y9\d{14}$/);

  const trigger = page.getByRole("button", { name: "Show your code full screen" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: /full screen/i });
  await expect(dialog).toBeVisible();
  const token = (await code.textContent())!;
  await expect(dialog.getByRole("img", { name: new RegExp(`^QR code 118Y9\\d{14}$`) })).toBeVisible();
  await expect(dialog).toContainText(/New code in \d+ seconds?/);
  await expect(dialog).toContainText("brightness up");
  expect(tokensAroundNow()).toContain(token);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wake: string[] }).__wake)).toContain("request:screen");

  // Nothing of the app shows through: the overlay is on top at the header's coordinates.
  expect(await page.evaluate(() => !!document.elementFromPoint(20, 20)?.closest('[role="dialog"]'))).toBe(true);

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/my-code-fullscreen-${test.info().project.name}.png` });
  }

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wake: string[] }).__wake)).toContain("release");
});

for (const scheme of ["light", "dark"] as const) {
  for (const width of [375, 1440]) {
    test(`the pass renders whole in the ${scheme} theme at ${width}px`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await signIn(page);
      await serveApi(page, routes());
      await page.goto("/my-code");
      await expect(page.getByLabel("Your code", { exact: true })).toHaveText(/^118Y9\d{14}$/);
      const pass = page.getByRole("article", { name: "Your member pass" });
      const box = (await pass.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      // The QR panel is paper white in both themes.
      const panel = await page.locator("[data-qr-panel]").evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(panel).toBe("rgb(255, 255, 255)");
      // No watermark on a code surface (D5).
      await expect(pass.locator("[data-wm-glyph]")).toHaveCount(0);
      if (SHOTS && test.info().project.name === "desktop") {
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: `${SHOTS}/my-code-${scheme}-${width}.png`, fullPage: false });
      }
    });
  }
}
