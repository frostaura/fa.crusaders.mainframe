import AxeBuilder from "@axe-core/playwright";
import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";

/**
 * R23 in a real browser — "all admins must receive emails for things like new member requests".
 *
 * <p>
 * Three surfaces, one catalogue: Settings → Admin alerts (the club's thresholds, which ride the
 * save bar, and the admin's own inbox switches, which do not); the Overview's Recent alerts; and
 * the same switches on an admin's Profile. The unit suite holds the wiring; these hold what only a
 * browser can — the wire bodies as sent, the layout at a phone's width with nothing pushed
 * sideways, and axe in both themes.
 * </p>
 */

const SETTINGS = {
  slice_minutes: 15, slice_price_credits: 8, advance_booking_days: 14, day_start_minute: 360, day_end_minute: 1320,
  penalty_pct: 30, grace_window_minutes: 5, penalty_window_minutes: 15, timezone: "Africa/Johannesburg",
  button_map: ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "off"],
  operating_hours: { mon: "06:00-22:00", sat: "07:00-20:00" },
  credits_per_zar_regular: 1.6, topup_block_zar: 100, topup_max_zar_per_member: 1000,
  member_per_day_max_minutes: 60, peak_hours: "16:00-19:00", peak_advance_hours_for_regular: 1,
  retention_years: 2, no_show_lookback_days: 7, walk_up_max_minutes: 90, heartbeat_seconds: 60,
  activation_forward_window_minutes: 120, activation_cue_window_minutes: 10, qr_lifetime_seconds: 60,
  roster_window_minutes: 120, device_alert_cooldown_minutes: 60,
  gate_unlock_seconds: 15, gate_access_policy: "active_member", gate_early_entry_minutes: 30,
  currency_symbol: "R",
  fault_spike_count: 5, fault_spike_minutes: 15, application_reminder_hours: 24, admin_notification_retention_days: 90,
  topup_failure_cooldown_minutes: 30, overdraft_cooldown_minutes: 15,
};

const KINDS = [
  { kind: "member.registered", title: "New membership applications", description: "Somebody has applied to join and is waiting for approval.", optional: true, opted_out: false },
  { kind: "member.application_pending", title: "Applications still waiting", description: "A daily reminder while any application has waited longer than the club's reminder threshold.", optional: true, opted_out: false },
  { kind: "device.offline", title: "Court box or door stopped reporting", description: "A board the club has acknowledged has gone silent.", optional: true, opted_out: true },
  { kind: "admin.role_changed", title: "Administrator changes", description: "Somebody was made an administrator, or stopped being one.", optional: false, opted_out: false },
  { kind: "code.forgery_suspected", title: "Suspected forged codes", description: "A board accepted a code this club could not have issued.", optional: false, opted_out: false },
];

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function notice(id: string, over: Record<string, unknown> = {}) {
  return {
    id, kind: "member.registered", title: "New membership applications", headline: "Thandi Mokoena applied to join",
    link: "/admin/members", subject_user_id: null, created_at: minutesAgo(5),
    delivery: { state: "sent", sent_at: minutesAgo(4), finished_at: minutesAgo(4), recipients: 3 },
    ...over,
  };
}

const FIRST_PAGE = {
  items: [
    notice("n1"),
    notice("n2", {
      kind: "device.offline", title: "Court box or door stopped reporting", headline: "Court 2 box stopped reporting",
      link: "/admin/monitoring/devices", created_at: minutesAgo(180),
      delivery: { state: "failed", sent_at: null, finished_at: minutesAgo(170), recipients: 0 },
    }),
    notice("n3", {
      kind: "code.forgery_suspected", title: "Suspected forged codes",
      headline: "Court 1 box accepted a code this club could not have issued", link: "/admin/monitoring/changes",
      created_at: minutesAgo(60 * 26), delivery: { state: "suppressed", sent_at: null, finished_at: minutesAgo(60 * 26), recipients: 0 },
    }),
  ],
  next_cursor: "older",
};

const OLDER_PAGE = {
  items: [notice("n4", { headline: "Sipho Dlamini applied to join", created_at: minutesAgo(60 * 24 * 9) })],
  next_cursor: null,
};

function base(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    ...extra,
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    {
      path: "/api/v1/me/profile",
      body: {
        user_id: SESSION_ADMIN.user_id, email: "admin@sample.local", is_admin: true, tenant_slug: "crusaders",
        full_name: "Crusaders Admin", membership_number: "ADMIN-0001", photo_url: null, status: "Active",
      },
    },
    { path: "/api/v1/admin/settings/", body: SETTINGS },
    { path: "/api/v1/admin/notifications/kinds", body: { kinds: KINDS } },
    { path: "/api/v1/admin/notifications", body: FIRST_PAGE },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/me/webauthn/credentials", body: [] },
    { path: "/api/v1/me/door", body: { doors: false } },
    // Its own route: under "/me/door" alone the history read got the flag's body back.
    { path: "/api/v1/me/door/history", body: { items: [], next_cursor: null, retention_days: 90, timezone: "Africa/Johannesburg" } },
  ];
}

/** The older page is asked for by cursor; Playwright's routes see the query, the stub's path does not. */
async function serveFeed(page: Page, extra: ApiRoute[] = []) {
  await serveApi(page, base(extra));
  await page.route((url) => url.pathname === "/api/v1/admin/notifications", async (route) => {
    const url = new URL(route.request().url());
    const body = url.searchParams.get("cursor") === "older" ? OLDER_PAGE : FIRST_PAGE;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

async function openSettingsAlerts(page: Page, extra: ApiRoute[] = []) {
  await signIn(page);
  await page.addInitScript(() => window.localStorage.setItem("crusaders:settings-intro-dismissed", "1"));
  await serveFeed(page, extra);
  await page.goto("/admin/settings");
  await page.getByRole("button", { name: "Admin alerts" }).click();
  return page.getByRole("region", { name: "Admin alerts" });
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

const SHOTS = process.env.P69_SHOTS_DIR;

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    // Colours ease between themes; a capture taken mid-ease shows labels half-faded.
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/${name}-${page.viewportSize()?.width}-${scheme}.png`, fullPage: true });
  }
}

test("Settings → Admin alerts saves the club's thresholds snake_case, and the admin's own switches at once", async ({ page }) => {
  const settingsPuts: Record<string, unknown>[] = [];
  const preferencePuts: unknown[] = [];
  const section = await openSettingsAlerts(page, [
    { method: "PUT", path: "/api/v1/admin/settings/", respond: (r) => { settingsPuts.push(r.body as Record<string, unknown>); return { saved: true }; } },
    { method: "PUT", path: "/api/v1/me/preferences", respond: (r) => { preferencePuts.push(r.body); return { admin_notification_optouts: [] }; } },
  ]);

  // The admin's own switch: saved on the flip, never counted by the save bar.
  const panel = section.getByRole("region", { name: "Your email alerts" });
  await panel.getByRole("switch", { name: "New membership applications" }).click();
  await expect(page.getByText("You won’t be emailed about new membership applications any more.")).toBeVisible();
  expect(preferencePuts).toEqual([{ admin_notification_optouts: ["member.registered", "device.offline"] }]);
  await expect(page.getByRole("region", { name: "Unsaved settings" })).toHaveCount(0);

  // A locked kind says why, beside the lock.
  await expect(panel.getByText(/Always on\. Who holds admin rights/)).toBeVisible();

  // The club's threshold and a notifier cooldown ride the save bar, snake_case.
  await section.getByRole("spinbutton", { name: "Fault spike (faults)" }).fill("8");
  await section.getByRole("spinbutton", { name: "Failed purchase emails — quiet time (minutes)" }).fill("45");
  const bar = page.getByRole("region", { name: "Unsaved settings" });
  await expect(bar).toContainText("2 unsaved changes");
  await bar.getByRole("button", { name: "Save changes" }).click();
  // Review round 2 (F3-4): the save bar itself stays as a VISIBLE status that takes focus — the
  // toast and the 1×1 screen-reader landing that emptied after 3 s are gone.
  const saved = page.locator("[data-save-landing]");
  await expect(saved).toBeVisible();
  await expect(saved).toContainText("Settings saved.");
  await expect(saved).toBeFocused();
  expect(settingsPuts).toHaveLength(1);
  expect(settingsPuts[0]).toMatchObject({
    fault_spike_count: 8, topup_failure_cooldown_minutes: 45, overdraft_cooldown_minutes: 15, sliceMinutes: 15,
  });
  expect(Object.keys(settingsPuts[0])).not.toContain("faultSpikeCount");
  expect(JSON.stringify(settingsPuts[0])).not.toMatch(/league|buttonMap|slice_?price|credits_?per_?zar|topup_?(block|max)/i);
});

test("Settings → Money & packages points at Packages and Groups, and holds no rate", async ({ page }) => {
  await signIn(page);
  await page.addInitScript(() => window.localStorage.setItem("crusaders:settings-intro-dismissed", "1"));
  await serveFeed(page);
  await page.goto("/admin/settings");
  await page.getByRole("button", { name: "Money & packages" }).click();
  const money = page.getByRole("region", { name: "Money & packages" });
  await expect(money.getByRole("link", { name: "Set the club's packages on Packages" })).toHaveAttribute("href", "/admin/packages");
  await expect(money.getByRole("link", { name: "Set a group's package discount on Groups" })).toHaveAttribute("href", "/admin/groups");
  await expect(money.getByRole("spinbutton")).toHaveCount(0);
  await expect(money).not.toContainText(/credit|top.?up|\bcr\b/i);
});

test("the Overview lists recent alerts, loads older ones, and links each to where it is dealt with", async ({ page }) => {
  await signIn(page);
  await serveFeed(page);
  await page.goto("/admin");

  const alerts = page.getByRole("region", { name: "Recent alerts" });
  const first = alerts.getByRole("link", { name: "Thandi Mokoena applied to join" });
  await expect(first).toBeVisible();
  await expect(first).toHaveAttribute("href", "/admin/members");
  await expect(alerts.locator("[data-delivery='failed']")).toHaveText("Email failed");
  await expect(alerts.locator("[data-delivery='suppressed']")).toHaveText("Not emailed — told recently");

  await alerts.getByRole("button", { name: "Show older alerts" }).click();
  await expect(alerts.getByRole("link", { name: "Sipho Dlamini applied to join" })).toBeVisible();
  await expect(alerts.getByRole("button", { name: "Show older alerts" })).toHaveCount(0);
  await noSidewaysScroll(page);
});

test("an admin's Profile carries the same email alerts", async ({ page }) => {
  await signIn(page);
  await serveFeed(page, [{ method: "PUT", path: "/api/v1/me/preferences", body: { admin_notification_optouts: [] } }]);
  await page.goto("/profile?tab=account");

  const card = page.getByRole("region", { name: "Email alerts" });
  await expect(card.getByRole("switch", { name: "Court box or door stopped reporting" })).not.toBeChecked();
  await card.getByRole("switch", { name: "Court box or door stopped reporting" }).click();
  await expect(card.getByRole("switch", { name: "Court box or door stopped reporting" })).toBeChecked();
  await expect(card.getByRole("switch", { name: "Suspected forged codes" })).toHaveAttribute("aria-disabled", "true");
  await noSidewaysScroll(page);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the three surfaces pass axe, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await openSettingsAlerts(page);
    await expect(page.getByRole("switch", { name: "New membership applications" })).toBeVisible();
    const check = async () => {
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    };
    await check();

    await page.goto("/admin");
    await expect(page.getByRole("link", { name: "Thandi Mokoena applied to join" })).toBeVisible();
    await check();

    await page.goto("/profile?tab=account");
    await expect(page.getByRole("switch", { name: "New membership applications" })).toBeVisible();
    await check();
  });
}

test("screenshots at 375 and 1440, both themes", async ({ page }) => {
  test.skip(!SHOTS, "set P69_SHOTS_DIR to write them");
  for (const width of [375, 1440]) {
    // Tall: the shell scrolls inside its own container, so a full-page capture of a short
    // viewport shows one screenful. This shows the whole section.
    await page.setViewportSize({ width, height: 2600 });
    const section = await openSettingsAlerts(page);
    await expect(section.getByRole("switch", { name: "New membership applications" })).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    await noSidewaysScroll(page);
    await shoot(page, "settings-alerts");

    await page.goto("/admin");
    await expect(page.getByRole("link", { name: "Thandi Mokoena applied to join" })).toBeVisible();
    await noSidewaysScroll(page);
    await shoot(page, "overview");

    await page.goto("/profile?tab=account");
    await expect(page.getByRole("region", { name: "Email alerts" }).getByRole("switch").first()).toBeVisible();
    await noSidewaysScroll(page);
    await shoot(page, "profile");
  }
});
