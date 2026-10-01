import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes } from "./playersKit";
import { deviceErrorFixture, deviceErrorPageFixture } from "../src/test/monitoringFixtures";
import { ADMIN_NAV_ITEMS } from "../src/components/admin/adminNav";
import { ADMIN_TOUR } from "../src/lib/onboardingCopy";

// A cold dev server compiles the admin frame on first ask, and the machine is shared: room to do so.
test.describe.configure({ timeout: 90_000 });

/**
 * Review round 5, lane E2 — the admin console's monitoring, Overview and config screens, measured in
 * a real browser at the widths and text sizes the round's reviewers found them broken at.
 */

const ZONE = "Africa/Johannesburg";

const SETTINGS = {
  slice_minutes: 15, slice_price_credits: 8, advance_booking_days: 14, day_start_minute: 360, day_end_minute: 1320,
  penalty_pct: 30, grace_window_minutes: 5, penalty_window_minutes: 15, timezone: ZONE,
  button_map: ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "off"],
  operating_hours: { mon: "06:00-22:00", sat: "07:00-20:00" }, credits_per_zar_regular: 1.6, topup_block_zar: 100,
  topup_max_zar_per_member: 1000, member_per_day_max_minutes: 60, peak_hours: "16:00-19:00",
  peak_advance_hours_for_regular: 1, retention_years: 2, no_show_lookback_days: 7, walk_up_max_minutes: 90,
  heartbeat_seconds: 60, activation_forward_window_minutes: 120, activation_cue_window_minutes: 10,
  qr_lifetime_seconds: 60, roster_window_minutes: 120, device_alert_cooldown_minutes: 60,
  gate_unlock_seconds: 3, gate_access_policy: "active_member", gate_early_entry_minutes: 30,
};

/** A court box as a club has it: named, acknowledged, reporting. */
function board(i: number) {
  return {
    id: `11111111-1111-1111-1111-1111111111${String(i).padStart(2, "0")}`,
    device_code: `box-a1b2${String(i).padStart(2, "0")}`, name: `Court box ${i}`, kind: "CourtBox", hardware: "Esp8266",
    court_numbers: [i], gate_key: null, mac_address: `5ccf7f1a2b${String(i).padStart(2, "0")}`, enabled: true,
    last_seen_at: new Date().toISOString(), last_ip_address: `192.168.68.${150 + i}`, running_version: "2.0.0",
    mega_version: "1.4.0", created_at: "2026-09-01T08:00:00Z", auto_registered: false, button_map: null,
    effective_heartbeat_seconds: 60,
  };
}

const COURTS = Array.from({ length: 8 }, (_, i) => ({
  id: `22222222-2222-2222-2222-2222222222${String(i).padStart(2, "0")}`, court_number: i + 1, name: `Court ${i + 1}`,
  court_type: "Squash", slice_price_credits: 8, is_active: true,
}));

/** The extras come FIRST: the fixture's longest-prefix sort is stable, so on a tie they win. */
function adminRoutes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    ...extra,
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: ZONE } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: { critical: 14, error: 9, warning: 23 } } },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/schedules", body: { schedules: [], timezone: ZONE } },
    { path: "/api/v1/admin/notifications", body: { items: [], next_cursor: null } },
    { path: "/api/v1/admin/devices/api-key", body: { api_key: "cmk_9F2Kq7Xd4bTn6Ls0", regenerated_at: "2026-09-01T08:30:00Z" } },
    { path: "/api/v1/admin/devices/", body: [board(1)] },
    { path: "/api/v1/admin/settings/", body: SETTINGS },
    { path: "/api/v1/admin/courts/", body: COURTS },
    ...memberShellRoutes({ unread: 3, admin: true }),
  ];
}

async function open(page: Page, path: string, size: { width: number; height?: number }, bigText: boolean, extra: ApiRoute[] = []) {
  await page.setViewportSize({ width: size.width, height: size.height ?? 900 });
  await signIn(page);
  await serveApi(page, adminRoutes(extra));
  await page.goto(path);
  if (bigText) await page.addStyleTag({ content: "html { font-size: 32px; }" });
  await expect(page.locator("#main-content h1").first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("#main-content .animate-pulse")).toHaveCount(0, { timeout: 30_000 });
}

/** Sideways scroll on the document and on the app's own scroller. */
async function sideways(page: Page) {
  return page.evaluate(() => {
    const main = document.getElementById("main-content");
    return Math.max(...[document.documentElement, main].filter(Boolean).map((el) => el!.scrollWidth - el!.clientWidth));
  });
}

/** Every word of the matched elements' text, and how many line boxes each one was laid out on. */
async function wordLines(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((els) => els.flatMap((el) => {
    const out: { word: string; lines: number }[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement?.closest(".sr-only, [aria-hidden='true']")) continue;
      for (const m of (n.textContent ?? "").matchAll(/[A-Za-z]{3,}/g)) {
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

async function noWordBroken(page: Page, selector: string) {
  const broken = (await wordLines(page, selector)).filter((w) => w.lines > 1).map((w) => w.word);
  expect(broken, `words broken across lines in ${selector}`).toEqual([]);
}

test.describe("R5 V-16 — the section switcher at 320 / 200 %", () => {
  // Every section: the bar names the group ("Courts & hardware") and the section ("Repeating bookings").
  for (const path of ADMIN_NAV_ITEMS.map((item) => item.path)) {
    test(`never breaks a word mid-word on ${path}`, async ({ page }) => {
      await open(page, path, { width: 320 }, true, [
        { path: "/api/v1/admin/monitoring/errors", body: deviceErrorPageFixture([]) },
      ]);
      await expect(page.locator("[data-admin-section-bar] button").first()).toBeVisible();
      await noWordBroken(page, "[data-admin-section-bar] button");
      expect(await sideways(page)).toBeLessThanOrEqual(1);
    });
  }
});

test.describe("R5 F5-2 — Faults on a phone", () => {
  const rows = Array.from({ length: 6 }, (_, i) => deviceErrorFixture({
    id: `e${i}`, device_id: `d${i % 2}`, device_name: i % 2 ? "Front door" : "Box 1-4",
  }));

  test("the fault's text has the row's width, with Mark resolved under it", async ({ page }) => {
    await open(page, "/admin/monitoring/faults", { width: 390 }, false, [
      { path: "/api/v1/admin/monitoring/errors", body: deviceErrorPageFixture(rows) },
    ]);
    const text = page.locator("[data-fault-text]").first();
    const box = (await text.boundingBox())!;
    expect(box.width, "the text column").toBeGreaterThan(250);
    const button = (await text.getByRole("button", { name: /Mark resolved/ }).boundingBox())!;
    const means = (await text.locator("dd").first().boundingBox())!;
    expect(button.y, "the action sits under the text").toBeGreaterThan(means.y + means.height - 1);
    expect(means.width, "a value has the column's width (the terms stack)").toBeGreaterThan(box.width - 2);
    console.log(`faults@390 height=${await page.evaluate(() => document.getElementById("main-content")!.scrollHeight)} text=${Math.round(box.width)}`);
  });

  for (const path of ["/admin/monitoring/faults", "/admin/monitoring/changes"]) {
    test(`X5-11: nothing scrolls sideways on ${path} at 320 / 200 %`, async ({ page }) => {
      await open(page, path, { width: 320 }, true, [
        { path: "/api/v1/admin/monitoring/errors", body: deviceErrorPageFixture(rows) },
        { path: "/api/v1/admin/changes", body: { rows: [], total: 0, cursor: null, timezone: ZONE } },
      ]);
      expect(await sideways(page)).toBeLessThanOrEqual(1);
    });
  }
});

test.describe("R5 §3.16 — Boards on a phone", () => {
  test("eight boards stay dense at 390", async ({ page }) => {
    await open(page, "/admin/monitoring/devices", { width: 390 }, false, [
      { path: "/api/v1/admin/devices/", body: Array.from({ length: 8 }, (_, i) => board(i + 1)) },
    ]);
    const cards = page.locator("[data-board-card]");
    await expect(cards).toHaveCount(8);
    const heights = await cards.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    if (process.env.E2_SHOTS) await cards.first().screenshot({ path: `${process.env.E2_SHOTS}/board-390.png` });
    // 234px each before (the activity toggle had a line of its own); the toggle now joins the strip.
    for (const h of heights) expect(h, "one board's card at 390").toBeLessThanOrEqual(200);
  });
});

/** A group as the API sends it. */
function group(overrides: Record<string, unknown>) {
  return {
    description: null, status: "active", sort_order: 0, is_system_default: false,
    pricing: { mode: "inherit_court", multiplier_bps: 10_000, flat_slice_price_credits: null },
    caps: { max_slots_per_day: null, max_minutes_per_day: null, advance_booking_days: null },
    windows: [], member_count: 0, system_key: null, credits_per_zar: null, peak_priority: null,
    ...overrides,
  };
}

const GROUPS = [
  group({ id: "g-league", name: "League", system_key: "league", credits_per_zar: 2.4, peak_priority: true, member_count: 41 }),
  group({ id: "g-social", name: "Social evenings", member_count: 17, sort_order: 1, peak_priority: false }),
  group({ id: "g-old", name: "Winter league 2025", status: "archived", sort_order: 2, peak_priority: true }),
];

test.describe("R5 F5-5 / X5-6 — Groups", () => {
  test("two groups share the row at 1920, with no empty third track", async ({ page }) => {
    await open(page, "/admin/groups", { width: 1920, height: 1080 }, false, [
      { path: "/api/v1/admin/member-groups", body: { groups: GROUPS } },
    ]);
    const cards = page.locator("[data-group-card='g-league'], [data-group-card='g-social']");
    await expect(cards).toHaveCount(2);
    const grid = page.locator("[data-group-card='g-league']").locator("xpath=ancestor::*[@data-auto-grid][1]");
    const [gridBox, a, b] = [await grid.boundingBox(), await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()];
    // Together they reach the grid's far edge: nothing is left for an empty track.
    expect(b!.x + b!.width, "the pair fills the row").toBeGreaterThan(gridBox!.x + gridBox!.width - 2);
    expect(a!.width, "each takes half, not a third").toBeGreaterThan(gridBox!.width / 2 - 40);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`an archived card passes axe colour contrast (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, "/admin/groups", { width: 1280 }, false, [
        { path: "/api/v1/admin/member-groups", body: { groups: GROUPS } },
      ]);
      const archived = page.locator("[data-group-card='g-old']");
      await expect(archived).toBeVisible();
      const result = await new AxeBuilder({ page }).withRules(["color-contrast"]).include("[data-group-card='g-old']").analyze();
      expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
      expect(await archived.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    });
  }
});

const KINDS = [
  { kind: "member.registered", title: "New membership applications", description: "Somebody has applied to join and is waiting for approval.", optional: true, opted_out: false },
  { kind: "member.application_pending", title: "Applications still waiting", description: "A daily reminder while any application has waited longer than the club's reminder threshold.", optional: true, opted_out: false },
  { kind: "device.offline", title: "Court box or door stopped reporting", description: "A board the club has acknowledged has gone silent.", optional: true, opted_out: true },
  { kind: "code.forgery_suspected", title: "Suspected forged codes", description: "A board accepted a code this club could not have issued.", optional: false, opted_out: false },
];

test.describe("R5 X5-5 — email alert switches at 390 / 200 %", () => {
  test("labels wrap by word, never mid-word", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await signIn(page);
    await serveApi(page, adminRoutes([
      { path: "/api/v1/admin/notifications/kinds", body: { kinds: KINDS } },
      { path: "/api/v1/me/webauthn/credentials", body: [] },
      { path: "/api/v1/me/door/history", body: { items: [], next_cursor: null, retention_days: 90, timezone: ZONE } },
    ]));
    await page.goto("/profile?tab=account");
    await page.addStyleTag({ content: "html { font-size: 32px; }" });
    const card = page.getByRole("region", { name: "Email alerts" });
    await expect(card.getByRole("switch", { name: "Suspected forged codes" })).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    await noWordBroken(page, "[data-alert-kind] label, [data-alert-kind] [data-slot='field-description']");
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });
});

test.describe("R5 X5-8 / V4-5 — the admin tour at 390 / 200 %", () => {
  test("keeps Close and Next in view, and says there is more below", async ({ page }) => {
    const prefs = {
      theme: "system", member_onboarding_completed_at: null, member_onboarding_dismissed_at: "2026-09-01T10:00:00Z",
      member_onboarding_last_step: null, admin_onboarding_completed_at: null, onboarding_version: 1, current_onboarding_version: 1,
    };
    await page.setViewportSize({ width: 390, height: 700 });
    await signIn(page);
    await serveApi(page, adminRoutes([
      {
        path: "/api/v1/me/profile",
        body: {
          user_id: SESSION_ADMIN.user_id, email: "admin@review.test", is_admin: true, tenant_slug: "crusaders",
          full_name: "Thandi Probe", membership_number: "M-9", photo_url: null, status: "active", preferences: prefs,
        },
      },
      { path: "/api/v1/me/preferences", body: { ...prefs, findable: false, show_in_leaderboards: false } },
    ]));
    await page.addInitScript(() => {
      const style = document.createElement("style");
      style.textContent = "html { font-size: 32px; }";
      document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style));
    });
    await page.goto("/admin");
    const mark = page.locator("[data-coachmark]");
    await expect(mark).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(400);
    const box = (await mark.boundingBox())!;
    const inside = async (name: string | RegExp) => {
      const b = (await mark.getByRole("button", { name, exact: typeof name === "string" }).boundingBox())!;
      return b.y >= box.y - 1 && b.y + b.height <= box.y + box.height + 1 && b.y + b.height <= 700;
    };
    expect(await inside(ADMIN_TOUR.next), "Next is in view").toBe(true);
    expect(await inside(ADMIN_TOUR.close), "Close is in view").toBe(true);
    // The popover scrolls: its foot says so while there is more below.
    const scrolls = await mark.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    if (scrolls) await expect(mark.locator("[data-coachmark-foot]")).toHaveAttribute("data-more", "true");

    if (process.env.E2_SHOTS) await page.screenshot({ path: `${process.env.E2_SHOTS}/tour-390-200.png` });
    // X5-8: Tab to Close from the popover — focused, and in view.
    await mark.focus();
    await page.keyboard.press("Tab");
    await expect(mark.getByRole("button", { name: ADMIN_TOUR.close, exact: true })).toBeFocused();
    expect(await inside(ADMIN_TOUR.close), "the focused Close is in view").toBe(true);
  });
});
