import type { Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { ARCHIVE_COPY, ASSIGN_COPY, GROUP_ACTIONS, GROUP_SHEET, RATE_COPY } from "../src/lib/groupsCopy";
import { CONFIRM_NOT_READY } from "../src/lib/confirmDialogCopy";

/**
 * Groups (P6, D2, R21) — the one place for a group's court price, top-up rate, peak say, booking
 * times and limits, driven in Chromium at 375px and 1440px, in both themes.
 *
 * <p>
 * jsdom lays nothing out, so the things measured here cannot be unit-tested: the page never
 * scrolls sideways on a phone, the editor sheet keeps its Save in view and every control in it is
 * a 44px target, the weekly painter fits its sheet, and a dialog always has its ×. The wire bodies
 * (rate, peak say, the archive's reason, the member's whole set) are asserted here too, because a
 * mis-cased key is a field the API silently never receives.
 * </p>
 *
 * <p>
 * `SHOT_DIR=<dir>` writes the screens to that directory in both themes — the lane's evidence,
 * never committed.
 * </p>
 */

const USER = "bbbbbbbb-0000-4000-8000-00000000000b";

const SETTINGS = {
  slice_minutes: 15, slice_price_credits: 8, credits_per_zar_regular: 1.6, topup_block_zar: 100,
  peak_hours: "17:00-19:00", peak_advance_hours_for_regular: 1, member_max_slots_per_day: 4,
  timezone: "Africa/Johannesburg",
  operating_hours: { mon: "06:00-22:00", tue: "06:00-22:00", wed: "06:00-22:00", thu: "06:00-22:00", fri: "06:00-22:00", sat: "07:00-18:00", sun: "07:00-18:00" },
};

const WEEKDAY_EVENINGS = ["mon", "tue", "wed", "thu", "fri"].map((day) => ({ day, start: "17:00", end: "21:00" }));

function group(overrides: Record<string, unknown>) {
  return {
    description: null, status: "active", sort_order: 0, is_system_default: false,
    pricing: { mode: "inherit_court", multiplier_bps: 10_000, flat_slice_price_credits: null },
    caps: { max_slots_per_day: null, max_minutes_per_day: null, advance_booking_days: null },
    windows: [], member_count: 0, system_key: null, credits_per_zar: null, peak_priority: null,
    ...overrides,
  };
}

const LEAGUE = group({ id: "g-league", name: "League", system_key: "league", credits_per_zar: 2.4, peak_priority: true, member_count: 41, sort_order: 0 });
const SOCIAL = group({
  id: "g-social", name: "Social evenings", description: "Weeknight social squash", member_count: 17, sort_order: 1,
  pricing: { mode: "multiplier", multiplier_bps: 7_500, flat_slice_price_credits: null },
  caps: { max_slots_per_day: 2, max_minutes_per_day: null, advance_booking_days: 7 }, windows: WEEKDAY_EVENINGS, peak_priority: false,
});
const OLD = group({ id: "g-old", name: "Winter league 2025", status: "archived", sort_order: 2 });

function routes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/wallet", body: { balance_minutes: 10, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@test.local", photo_url: null, membership_number: "A-1" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/settings/", body: SETTINGS },
    {
      path: "/api/v1/admin/members",
      body: [{
        membership_id: "cccccccc-0000-4000-8000-00000000000c", user_id: USER, email: "naledi@example.com",
        full_name: "Naledi Khumalo", membership_number: "CR-0184", photo_url: null, status: "Active",
        created_at: "2026-03-01T08:00:00Z", rejection_reason: null, balance_minutes: 120, email_verified: true,
        groups: [{ id: "g-social", name: "Social evenings", system_key: null, credits_per_zar: null, peak_priority: false }],
      }],
    },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    { path: "/api/v1/admin/member-groups", body: { groups: [LEAGUE, SOCIAL, OLD] } },
    {
      path: "/api/v1/admin/member-groups/g-social/members",
      body: { members: [{ user_id: USER, name: "Naledi Khumalo", membership_number: "CR-0184", added_at: "2026-09-01T08:00:00Z" }], total: 1, cursor: null },
    },
    ...extra,
  ];
}

async function shoot(page: Page, name: string) {
  const dir = process.env.SHOT_DIR;
  if (!dir) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${dir}/${name}-${page.viewportSize()?.width}-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** Every visible button and switch in `scope` is at least 44px tall (its hit area). */
async function tallEnough(page: Page, selector: string) {
  return page.evaluate((sel) => Array.from(document.querySelectorAll<HTMLElement>(`${sel} button, ${sel} [role="switch"], ${sel} [role="radio"]`))
    .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().height > 0)
    .map((el) => {
      const own = el.getBoundingClientRect().height;
      const after = parseFloat(getComputedStyle(el, "::after").height) || 0;
      return { name: el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "?", h: Math.max(own, after) };
    })
    .filter((b) => b.h < 44), selector);
}

// The phone project is measured at 375px (the narrowest phone this club supports), the desktop one
// at 1440px — one width per project, so no case runs twice.
test.describe("groups", () => {
  test.beforeEach(async ({ page }, info) => {
    const phone = info.project.name === "mobile";
    await page.setViewportSize(phone ? { width: 375, height: 812 } : { width: 1440, height: 900 });
    await signIn(page);
  });

  test("reads each group's rate, peak say, times and limits off its card, and never scrolls sideways", async ({ page }) => {
    await serveApi(page, routes());
    await page.goto("/admin/groups");
    await expect(page.getByRole("heading", { level: 2, name: "League", exact: true })).toBeVisible();

    const league = page.getByRole("list", { name: "League at a glance" });
    await expect(league.getByText("2.4 cr per R1")).toBeVisible();
    await expect(league.getByText("Grants peak")).toBeVisible();
    await expect(page.getByText("Built in")).toBeVisible();
    await expect(page.getByText(/2 slots a day and 7 days ahead/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Archived (1)" })).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await shoot(page, "groups-list");
  });

  /** Review round 2 (VIS F3-15): two cards side by side had their action rows at different heights. */
  test("lines the action rows of side-by-side cards up", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "cards sit side by side from xl");
    await serveApi(page, routes());
    await page.goto("/admin/groups");
    await expect(page.getByRole("heading", { level: 2, name: "League", exact: true })).toBeVisible();
    const tops = await page.locator("[data-group-card] [data-slot=card-footer]").evaluateAll((els) =>
      els.slice(0, 2).map((el) => Math.round(el.getBoundingClientRect().top)));
    expect(tops).toHaveLength(2);
    expect(Math.abs(tops[0] - tops[1])).toBeLessThanOrEqual(1);
  });

  test("edits the rate and the peak say in the sheet, and sends both", async ({ page }) => {
    const patched: unknown[] = [];
    await serveApi(page, routes([
      { method: "PATCH", path: "/api/v1/admin/member-groups/g-social", respond: ({ body }) => { patched.push(body); return SOCIAL; } },
    ]));
    await page.goto("/admin/groups");
    await page.getByRole("button", { name: /Edit Social evenings/ }).click();

    const sheet = page.getByRole("dialog", { name: GROUP_SHEET.editTitle("Social evenings") });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Close" })).toBeVisible();
    const rate = sheet.getByRole("switch", { name: RATE_COPY.inherit });
    await expect(rate).toBeChecked();
    await rate.click();
    await sheet.getByLabel(RATE_COPY.field()).fill("2.4");
    await expect(sheet.getByText("R100 → 240 cr")).toBeVisible();
    await sheet.getByRole("radio", { name: "Grants peak priority" }).click();
    await shoot(page, "group-sheet");

    // The painter fits the sheet: the page never scrolls sideways, and the grid is inside the panel.
    const grid = await sheet.getByRole("grid").boundingBox();
    const panel = await sheet.boundingBox();
    expect((grid?.x ?? 0) + 1).toBeGreaterThanOrEqual(panel?.x ?? 0);
    expect(await tallEnough(page, '[data-sheet="group"] [data-slot="dialog-footer"]')).toEqual([]);
    expect(await tallEnough(page, '[data-sheet="group"] section[aria-labelledby="group-peak"]')).toEqual([]);

    const save = sheet.getByRole("button", { name: `${GROUP_SHEET.save} to Social evenings` });
    await expect(save).toBeInViewport();
    await save.click();
    await expect(sheet).toBeHidden();
    expect(patched).toHaveLength(1);
    expect(patched[0]).toMatchObject({ creditsPerZar: 2.4, peakPriority: true, windows: WEEKDAY_EVENINGS });
  });

  test("archives only with a reason, and never offers the built-in group an archive", async ({ page }) => {
    const patched: unknown[] = [];
    await serveApi(page, routes([
      { method: "PATCH", path: "/api/v1/admin/member-groups/g-social", respond: ({ body }) => { patched.push(body); return { ...SOCIAL, status: "archived" }; } },
    ]));
    await page.goto("/admin/groups");

    // R3 X-2: nothing to offer the built-in group, so no ⋯ at all (it opened an empty menu).
    await expect(page.getByRole("heading", { name: "League", exact: true, level: 2 })).toBeVisible();
    await expect(page.getByRole("button", { name: GROUP_ACTIONS.more("League") })).toHaveCount(0);

    await page.getByRole("button", { name: GROUP_ACTIONS.more("Social evenings") }).click();
    await page.getByRole("menuitem", { name: GROUP_ACTIONS.archive }).click();
    const dialog = page.getByRole("dialog", { name: ARCHIVE_COPY.title("Social evenings") });
    await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
    // R3 A-16: enabled; a press without a reason names it and sends nothing.
    await dialog.getByRole("button", { name: ARCHIVE_COPY.confirm }).click();
    await expect(dialog.getByText(CONFIRM_NOT_READY)).toBeVisible();
    expect(patched).toHaveLength(0);
    await dialog.getByLabel(ARCHIVE_COPY.reasonLabel).fill("Season over");
    await shoot(page, "group-archive");
    await dialog.getByRole("button", { name: ARCHIVE_COPY.confirm }).click();
    await expect(dialog).toBeHidden();
    expect(patched).toEqual([{ status: "archived", reason: "Season over" }]);
  });

  test("moves a member between groups from the members list, showing the rate change first", async ({ page }) => {
    const put: unknown[] = [];
    const tariffNow = { top_up_credits_per_zar: 1.6, rate_group_id: null, peak_priority: false, peak_withheld_by: ["Social evenings"] };
    const tariffAfter = { top_up_credits_per_zar: 2.4, rate_group_id: "g-league", peak_priority: false, peak_withheld_by: ["Social evenings"] };
    await serveApi(page, routes([
      { method: "POST", path: "/api/v1/admin/member-groups/preview", body: { current: { tariff: tariffNow }, would_be: { tariff: tariffAfter } } },
      {
        method: "PUT", path: `/api/v1/admin/members/${USER}/groups`,
        respond: ({ body }) => { put.push(body); return { user_id: USER, groups: [LEAGUE, SOCIAL], added: ["g-league"], removed: [], tariff: tariffAfter }; },
      },
    ]));
    await page.goto("/admin/members");
    await page.getByRole("button", { name: "More actions for Naledi Khumalo" }).click();
    await page.getByRole("menuitem", { name: ASSIGN_COPY.change }).click();

    const dialog = page.getByRole("dialog", { name: ASSIGN_COPY.title("Naledi Khumalo") });
    await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
    await dialog.getByRole("combobox", { name: ASSIGN_COPY.add }).click();
    await page.getByRole("option", { name: /League/ }).click();
    await page.keyboard.press("Escape");
    await expect(dialog.getByText(/Top-up rate 1\.6 → 2\.4 cr per R1 \(from League\)/)).toBeVisible();
    await expect(dialog.getByText("Still no peak priority — Social evenings withholds it.")).toBeVisible();
    await shoot(page, "group-assign");

    await dialog.getByRole("button", { name: ASSIGN_COPY.saveLabel("Naledi", 2) }).click();
    await expect(dialog).toBeHidden();
    expect(put).toEqual([{ groupIds: ["g-social", "g-league"] }]);
  });
});
