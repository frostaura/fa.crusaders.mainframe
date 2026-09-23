import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";

/**
 * R13 in a real browser — "admin settings overwhelming: expand/collapse sections, onboarding,
 * floating tooltips, decent descriptions".
 *
 * <p>
 * The unit suite holds the wiring. These hold what only a browser can: that the page opens as ten
 * one-line answers rather than seventy fields, that the floating save bar sits clear of the phone's
 * tab bar and never pushes the page sideways, that leaving through the app's own navigation asks
 * first, and that the whole thing passes axe in both themes.
 * </p>
 */

const SETTINGS = {
  slice_minutes: 15, slice_price_credits: 8, advance_booking_days: 14, day_start_minute: 360, day_end_minute: 1320,
  penalty_pct: 30, grace_window_minutes: 5, penalty_window_minutes: 15, timezone: "Africa/Johannesburg",
  button_map: ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "off"],
  operating_hours: { mon: "06:00-22:00", sat: "07:00-20:00" },
  credits_per_zar_regular: 1.6, credits_per_zar_league: 2.4, topup_block_zar: 100, topup_max_zar_per_member: 1000,
  member_per_day_max_minutes: 60, peak_hours: "16:00-19:00", peak_advance_hours_for_regular: 1,
  retention_years: 2, no_show_lookback_days: 7, walk_up_max_minutes: 90, heartbeat_seconds: 60,
  activation_forward_window_minutes: 120, activation_cue_window_minutes: 10, qr_lifetime_seconds: 60,
  roster_window_minutes: 120, device_alert_cooldown_minutes: 60,
  gate_unlock_seconds: 15, gate_access_policy: "active_member", gate_early_entry_minutes: 30,
  door_log_retention_days: 90, door_refusal_spike_count: 8, door_refusal_spike_minutes: 20,
  club_contact_phone: "076 226 1390", club_contact_email: "squash@example.co.za",
  lcd_revert_seconds: 10, rapid_scan_window_seconds: 10, member_max_slots_per_day: 4,
  schedule_materialisation_days: 60, member_trace_enabled: true, currency_symbol: "R",
};

function routes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@sample.local", photo_url: null, membership_number: "ADMIN-0001", member_class: "Regular" } },
    { path: "/api/v1/admin/settings/", body: SETTINGS },
    ...extra,
  ];
}

async function openSettings(page: Page, extra: ApiRoute[] = []) {
  await signIn(page);
  await page.addInitScript(() => window.localStorage.setItem("crusaders:settings-intro-dismissed", "1"));
  await serveApi(page, routes(extra));
  await page.goto("/admin/settings");
  await expect(page.getByRole("button", { name: "Door gates" })).toBeVisible();
}

const unlock = (page: Page) => page.getByRole("spinbutton", { name: "Unlock time (seconds)" });

test("opens as ten one-line answers, and a section opens to its fields", async ({ page }) => {
  await openSettings(page);

  // Closed, the door section still says how the doors are set.
  const doors = page.getByRole("button", { name: "Door gates" });
  await expect(doors).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Any member in good standing · lock released 15 s")).toBeVisible();
  await expect(unlock(page)).toBeHidden();

  await doors.click();
  await expect(unlock(page)).toBeVisible();
});

test("finds a setting by search, and saves it from the floating bar", async ({ page }) => {
  const sent: unknown[] = [];
  await openSettings(page, [{
    method: "PUT", path: "/api/v1/admin/settings/",
    respond: (request) => { sent.push(request.body); return { saved: true }; },
  }]);

  await page.getByRole("searchbox", { name: "Search settings" }).fill("unlock");
  await expect(page.getByText("1 setting matches")).toBeVisible();
  await expect(page.getByRole("button", { name: "Bookings" })).toBeHidden();
  await unlock(page).fill("20");

  const bar = page.getByRole("region", { name: "Unsaved settings" });
  await expect(bar).toContainText("1 unsaved change");
  await bar.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect((sent[0] as Record<string, unknown>).gateUnlockSeconds).toBe(20);
  expect(sent[0]).not.toHaveProperty("buttonMap");
  await expect(bar).toBeHidden();
});

/** The bar floats above the phone's tab bar, and never covers it. */
test("keeps the save bar clear of the tab bar, with nothing pushed sideways", async ({ page }) => {
  // At rest: the bar slides up on arrival, and a box measured mid-slide is below the fold.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettings(page);
  await page.getByRole("button", { name: "Door gates" }).click();
  await unlock(page).fill("45");

  const bar = page.getByRole("region", { name: "Unsaved settings" });
  await expect(bar).toBeVisible();
  const barBox = (await bar.boundingBox())!;
  const tabs = page.locator("nav[aria-label='Main']");
  const tabBox = await tabs.boundingBox();
  const position = await tabs.evaluate((el) => getComputedStyle(el).position);
  if (tabBox && position === "fixed") expect(barBox.y + barBox.height).toBeLessThanOrEqual(tabBox.y + 1);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(1);
});

test("asks before the app's own navigation throws unsaved changes away", async ({ page }) => {
  await openSettings(page, [{ path: "/api/v1/wallet", body: { balance_credits: 0, entries: [], total_entries: 0, offset: 0, limit: 100 } }]);
  await page.getByRole("button", { name: "Door gates" }).click();
  await unlock(page).fill("20");

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Wallet" }).click();
  const dialog = page.getByRole("dialog", { name: "Leave without saving?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(/\/admin\/settings$/);
  await expect(unlock(page)).toHaveValue("20");
});

for (const scheme of ["light", "dark"] as const) {
  test(`passes axe with a section open and the save bar up, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await openSettings(page);
    await page.getByRole("button", { name: "Door gates" }).click();
    await unlock(page).fill("45");
    await expect(page.getByRole("region", { name: "Unsaved settings" })).toBeVisible();
    // Tall enough that nothing is "partially obscured" below the scroller's fold.
    const { width } = page.viewportSize()!;
    await page.setViewportSize({ width, height: 4000 });

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .include("#main-content")
      .analyze();
    const summary = results.violations
      .map((v) => `${v.id}: ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(" ")}`).join("\n")}`)
      .join("\n");
    expect(results.violations, summary).toEqual([]);
  });
}
