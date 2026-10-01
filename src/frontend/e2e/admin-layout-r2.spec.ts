import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect } from "./fixtures";

/**
 * Review round 2, VIS F3-15 and F3-14 — layout defects measured in Chromium, on a phone.
 */
const SETTINGS = {
  slice_minutes: 15, slice_price_credits: 8, advance_booking_days: 14, day_start_minute: 360, day_end_minute: 1320,
  penalty_pct: 30, grace_window_minutes: 5, penalty_window_minutes: 15, timezone: "Africa/Johannesburg",
  button_map: ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "off"],
  operating_hours: { mon: "06:00-22:00", sat: "07:00-20:00" },
  credits_per_zar_regular: 1.6, topup_block_zar: 100, topup_max_zar_per_member: 1000,
  member_per_day_max_minutes: 60, peak_hours: "16:00-19:00", peak_advance_hours_for_regular: 1,
  retention_years: 2, no_show_lookback_days: 7, walk_up_max_minutes: 90, heartbeat_seconds: 60,
  lcd_revert_seconds: 10, rapid_scan_window_seconds: 10, member_max_slots_per_day: 4, currency_symbol: "R",
};

const BASE = [
  { path: "/api/v1/whoami", body: SESSION_ADMIN },
  { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@sample.local", photo_url: null, membership_number: "ADMIN-0001" } },
  { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 100 } },
];

async function openSettings(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.addInitScript(() => window.localStorage.setItem("crusaders:settings-intro-dismissed", "1"));
  await serveApi(page, [...BASE, { path: "/api/v1/admin/settings/", body: SETTINGS }]);
  await page.goto("/admin/settings");
  // The admin frame and the Settings chunk (~420 modules) compile cold on a fresh dev server:
  // measured 1 s warm, 9-14 s for the first arrival under a loaded runner, where the default 5 s
  // left all three walks on "Opening the page…". The 20 s the other admin specs give it.
  await expect(page.getByRole("button", { name: "Door gates" })).toBeVisible({ timeout: 20_000 });
}

test("the settings search placeholder fits a 390px phone", async ({ page }) => {
  await openSettings(page);
  const search = page.getByRole("searchbox", { name: "Search settings" });
  const fits = await search.evaluate((input: HTMLInputElement) => {
    const style = getComputedStyle(input);
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const room = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return ctx.measureText(input.placeholder).width <= room;
  });
  expect(fits, "the placeholder is clipped").toBe(true);
});

test("a number with a unit draws no stepper over the unit", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("searchbox", { name: "Search settings" }).fill("Screen returns");
  const field = page.getByRole("spinbutton", { name: /Screen returns/ });
  await expect(field).toBeVisible();
  expect(await field.evaluate((el) => getComputedStyle(el).appearance)).toBe("textfield");
});

test("the save bar does not cover the field it says needs fixing", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("searchbox", { name: "Search settings" }).fill("Screen returns");
  const field = page.getByRole("spinbutton", { name: /Screen returns/ });
  await field.fill("999");
  const bar = page.getByRole("region", { name: "Unsaved settings" });
  await expect(bar).toContainText(/needs? fixing/);
  await page.waitForTimeout(400);
  const barTop = (await bar.boundingBox())!.y;
  const fieldBox = (await field.boundingBox())!;
  expect(fieldBox.y + fieldBox.height, "the field sits under the save bar").toBeLessThanOrEqual(barTop + 1);
});

test("the webhook catalogue reads as cards on a phone, with every description on screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await serveApi(page, [...BASE, { path: "/api/v1/admin/webhooks/", body: [] }]);
  await page.goto("/admin/webhooks");
  // R4 form factor (SPEC §3.15): on a phone the catalogue is folded until asked for.
  await page.getByRole("button", { name: "Show the catalogue" }).click({ timeout: 20_000 });
  const list = page.getByRole("list", { name: "Events and the variables each carries" });
  await expect(list).toBeVisible();
  await expect(page.getByRole("table", { name: "Events and the variables each carries" })).toBeHidden();
  const item = list.getByRole("listitem").first();
  const box = (await item.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  const described = await list.getByRole("listitem").evaluateAll((els) =>
    els.every((el) => { const r = el.children[1]?.getBoundingClientRect(); return !!r && r.right <= window.innerWidth; }));
  expect(described, "a description runs off the screen").toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
