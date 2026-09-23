import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";

/**
 * B5 / C11 / A9 in a real browser.
 *
 * <p>
 * The unit suite proves the attributes and the wire. Three things about this defect only
 * exist in a browser, and all three are what a reviewer actually met:
 * </p>
 *
 * <ul>
 *   <li><b>Distance.</b> The settings page is around 5 400 px tall. "Save has gone dead"
 *       is a different problem when the field that killed it is off-screen, and only a real
 *       layout can say whether the summary and the jump close that distance.</li>
 *   <li><b>The tab order.</b> <code>disabled</code> removes a button from it; jsdom will let
 *       you call <code>.focus()</code> on a disabled button and report success. Only a
 *       browser answers "can a keyboard reach this".</li>
 *   <li><b>Contrast.</b> The measured 2.27:1 was of a COMPOSITED pixel — a half-opacity fill
 *       over a tint. That number cannot be computed from the token file alone.</li>
 * </ul>
 */

const SETTINGS = {
  slice_minutes: 15,
  slice_price_credits: 8,
  advance_booking_days: 14,
  day_start_minute: 360,
  day_end_minute: 1320,
  penalty_pct: 30,
  grace_window_minutes: 5,
  penalty_window_minutes: 15,
  timezone: "Africa/Johannesburg",
  button_map: ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "off"],
  operating_hours: { mon: "06:00-22:00", sat: "07:00-20:00" },
  credits_per_zar_regular: 1.6,
 
  topup_block_zar: 100,
  topup_max_zar_per_member: 1000,
  member_per_day_max_minutes: 60,
  peak_hours: "16:00-19:00",
  peak_advance_hours_for_regular: 1,
  retention_years: 2,
  no_show_lookback_days: 7,
  walk_up_max_minutes: 90,
  heartbeat_seconds: 60,
  activation_forward_window_minutes: 120,
  activation_cue_window_minutes: 10,
  qr_lifetime_seconds: 60,
  roster_window_minutes: 120,
  device_alert_cooldown_minutes: 60,
  gate_unlock_seconds: 3,
  gate_access_policy: "active_member",
  gate_early_entry_minutes: 30,
  // W1's five, so the door records block renders rather than being skipped as an older API.
  door_log_retention_days: 90,
  door_refusal_spike_count: 8,
  door_refusal_spike_minutes: 20,
  club_contact_phone: "076 226 1390",
  club_contact_email: "squash@example.co.za",
};

function routes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@sample.local", photo_url: null, membership_number: "ADMIN-0001" } },
    { path: "/api/v1/admin/settings/", body: SETTINGS },
    ...extra,
  ];
}

/** The controls, by role and exact name — each setting's (i) is also named after its caption. */
const unlockField = (page: Page) => page.getByRole("spinbutton", { name: "Unlock time (seconds)" });
const retentionField = (page: Page) => page.getByRole("spinbutton", { name: "Keep door scans for (days)" });
const saveButton = (page: Page) => page.getByRole("button", { name: "Save changes" });

/**
 * Open the page — and, unless a hash is doing it, the Door gates section the fields live in
 * (R13: sections start closed, one line each).
 */
async function openSettings(page: Page, extra: ApiRoute[] = [], hash = "") {
  await signIn(page);
  await serveApi(page, routes(extra));
  await page.goto(`/admin/settings${hash}`);
  if (!hash) await page.getByRole("button", { name: "Door gates" }).click();
  await expect(unlockField(page)).toBeVisible();
}

/** WCAG 2.1 relative luminance of a `rgb(r, g, b)` string as the browser reports it. */
function luminance(rgb: string): number {
  const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number);
  const channel = (value: number) => {
    const raw = value / 255;
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test.describe("the settings page when the admin is wrong", () => {
  /**
   * The distance the finding is really about: Save used to be ~5 400 px below the door fields.
   * R13's save bar floats, so the summary is always beside Save — and its link still has to take
   * the admin back to a field that may have scrolled away.
   */
  test("says why it will not save without making the admin hunt for the field", async ({ page }) => {
    await openSettings(page);

    await unlockField(page).fill("45");

    const save = saveButton(page);
    await expect(save).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText(/1 setting needs fixing before this can be saved/)).toBeVisible();

    // The summary is BESIDE Save, not at the top of the page: an explanation the admin has to
    // scroll to find is the defect wearing different clothes.
    const summary = page.getByText(/setting needs fixing before this can be saved/);
    const summaryBox = (await summary.boundingBox())!;
    const saveBox = (await save.boundingBox())!;
    expect(Math.abs(summaryBox.y - saveBox.y)).toBeLessThan(200);

    // And the link takes the admin back up to the field, which is off-screen from here.
    await page.getByRole("link", { name: "Unlock time (seconds)" }).click();
    await expect(unlockField(page)).toBeFocused();
    await expect(unlockField(page)).toBeInViewport();
  });

  /**
   * The half jsdom cannot answer. `disabled` takes the button out of the tab order, so the
   * control carrying the reason was the one a keyboard user could never arrive at.
   */
  test("leaves Save reachable from the keyboard while it will not save", async ({ page }) => {
    await openSettings(page);
    await unlockField(page).fill("45");

    const save = saveButton(page);
    await save.focus();
    await expect(save).toBeFocused();

    // Pressing it is not a no-op: it takes the admin to the field that stopped it.
    await page.keyboard.press("Enter");
    await expect(unlockField(page)).toBeFocused();
  });

  /**
   * The 2.27:1 measurement, re-taken from the rendered pixels rather than from the tokens —
   * a composited half-opacity fill is not computable from the palette file.
   *
   * <p>
   * <b>Polled, not read once.</b> The base layer in `index.css` transitions `background-color`,
   * `border-color` and `color` on every button, so the first frame after the value goes out of
   * range still reports the idle blue — a read taken there measures the wrong pair and passes,
   * because `info.strong` on `info.soft` clears AA as happily as the warning pair does. That
   * is a test that would never have failed for a real regression.
   * </p>
   */
  test("paints the cannot-save state at a ratio a person can read", async ({ page }) => {
    await openSettings(page);
    await unlockField(page).fill("45");

    const save = saveButton(page);
    const painted = () => save.evaluate((el) => {
      const style = getComputedStyle(el);
      return { color: style.color, background: style.backgroundColor, border: style.borderTopColor, opacity: style.opacity };
    });

    // SC 1.4.11 on the boundary, against the white card behind it — and the wait for the
    // transition to land.
    await expect
      .poll(async () => contrast((await painted()).border, "rgb(255, 255, 255)"), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(3);

    const settled = await painted();
    // No opacity trick: the old treatment got its 2.27:1 by fading a perfectly good pair.
    expect(Number(settled.opacity)).toBe(1);
    expect(contrast(settled.color, settled.background)).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * A9. The doors page's "may not be releasing" signal links here with this hash; the page
   * has to land the admin on the number rather than at the top.
   */
  test("lands on the unlock field when entered on #setting-gate-unlock-seconds", async ({ page }) => {
    await openSettings(page, [], "#setting-gate-unlock-seconds");

    const unlock = unlockField(page);
    await expect(unlock).toBeFocused();
    await expect(unlock).toBeInViewport();
  });

  /** C11's last clause: clearing a box is an empty box, and 0 never reaches the wire. */
  test("never sends a zero for a box the admin only emptied", async ({ page }) => {
    const sent: unknown[] = [];
    await openSettings(page, [
      {
        method: "PUT",
        path: "/api/v1/admin/settings/",
        respond: (request) => { sent.push(request.body); return { saved: true }; },
      },
    ]);

    await page.getByRole("button", { name: "Records & privacy" }).click();
    await retentionField(page).fill("");
    // Pressed from the keyboard rather than `.click()`: Playwright's own actionability check
    // reads `aria-disabled="true"` as "not enabled" and waits for it to clear, which it never
    // does. A person with a mouse can press this button — that is the entire point of it not
    // being `disabled` — so the press has to go in by a route that does not re-apply the
    // assumption the fix removes.
    await saveButton(page).focus();
    await page.keyboard.press("Enter");
    await expect(retentionField(page)).toBeFocused();
    expect(sent).toHaveLength(0);

    await retentionField(page).fill("30");
    await saveButton(page).click();
    await expect.poll(() => sent.length).toBe(1);
    expect((sent[0] as Record<string, unknown>).doorLogRetentionDays).toBe(30);
  });
});
