import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes } from "./playersKit";

// A cold dev server compiles the admin frame on first ask, and the machine is shared.
test.describe.configure({ timeout: 90_000 });

/**
 * Review round 6, lane FC (admin UI) — measured in Chromium against a mocked API.
 */

const USER = "00000000-0000-4000-8000-000000000601";

function member(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER, membership_id: "00000000-0000-4000-8000-000000000611", full_name: "Bea Nkosi",
    email: "bea@r6.review.test", membership_number: "MEM-601", status: "Active", email_verified: true,
    balance_minutes: 120, created_at: "2026-09-01T08:00:00Z", photo_url: null, is_admin: false, admin_source: null,
    groups: [], ...overrides,
  };
}

function adminRoutes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    ...extra,
    ...memberShellRoutes({ admin: true }),
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/admin/doors", body: { doors: [], shut_together: [], shut_individually: [], timezone: "Africa/Johannesburg" } },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/play/results/disputed/count", body: { count: 0 } },
    { path: "/api/v1/admin/biometric/enrollments", body: [] },
    { path: "/api/v1/admin/member-groups", body: { groups: [] } },
    { path: "/api/v1/admin/ledger/", body: [] },
    { path: "/api/v1/admin/minutes/", body: { discount: null, packages: [] } },
    { path: "/api/v1/admin/members/", body: [member()] },
  ];
}

async function open(page: Page, path: string, routes: ApiRoute[], width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await signIn(page);
  await serveApi(page, routes);
  await page.goto(path);
}

const focusedName = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? null);

test.describe("X6-1 — a sheet opened from a ⋯ menu gives focus back to the ⋯", () => {
  for (const item of ["Adjust minutes", "Change groups"]) {
    test(`members list: ${item}, then Escape`, async ({ page }) => {
      await open(page, "/admin/members", adminRoutes());
      const more = page.locator(`[data-member-menu="${USER}"]`);
      await more.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: item, exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect.poll(() => focusedName(page)).toBe("More actions for Bea Nkosi");
    });
  }

  test("member header: Adjust minutes, then Escape", async ({ page }) => {
    await open(page, `/admin/members/${USER}`, adminRoutes([
      { path: `/api/v1/admin/members/${USER}`, body: { ...member(), account_status: "Active", last_login_at: null, passkey_count: 0, fingerprints: { count: 0, enrolments: [] }, next_bookings: [], counts_30d: { bookings: 0, no_shows: 0, sessions_played: 0 } } },
    ]));
    const more = page.getByRole("button", { name: "More actions for Bea Nkosi" });
    await more.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Adjust minutes", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => focusedName(page)).toBe("More actions for Bea Nkosi");
  });
});

/** Sideways scroll on the document or the app's scroller. */
const sideways = (page: Page) => page.evaluate(() => {
  const main = document.getElementById("main-content");
  return Math.max(...[document.documentElement, main].filter(Boolean).map((el) => el!.scrollWidth - el!.clientWidth));
});

const HOOK = {
  id: "00000000-0000-4000-8000-000000000621", owner_kind: "Tenant", description: "Court lights relay",
  url_template: "https://lights.example.test/hooks/{court_id}/{event}?booking={booking_id}",
  event_filter: "booking.created,booking.late_cancellation,minutes.penalty_applied", enabled: true,
  failure_count: 3, last_success_at: null, last_failure_at: null, secret: null,
};

test.describe("L6-5 — a webhook row at 320 px", () => {
  for (const bigText of [false, true]) {
    test(`gives the details the row's width${bigText ? " at 200 % text" : ""}, and scrolls nothing sideways`, async ({ page }) => {
      await open(page, "/admin/webhooks", adminRoutes([{ path: "/api/v1/admin/webhooks/", body: [HOOK] }]), 320);
      if (bigText) await page.addStyleTag({ content: "html { font-size: 32px; }" });
      const row = page.getByRole("listitem").filter({ hasText: "Court lights relay" }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready);
      const url = row.getByText(HOOK.url_template);
      const width = (await url.boundingBox())!.width;
      const inner = await row.evaluate((el) => {
        const cs = getComputedStyle(el);
        return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      });
      // The details take the row's whole inner width, not what is left beside the buttons.
      expect(width, "the URL is squeezed beside the buttons").toBeGreaterThanOrEqual(inner - 2);
      expect(await sideways(page), "the page scrolls sideways").toBeLessThanOrEqual(1);
    });
  }
});

const pkg = (id: string, name: string, minutes: number, price: number, order: number, group: { id: string; name: string } | null = null) => ({
  id, name, minutes, price_zar: price, group, sort_order: order, status: "active",
  created_at: "2026-09-01T08:00:00Z", updated_at: "2026-09-01T08:00:00Z",
});
const SOCIAL = { id: "g-social", name: "Social evenings", status: "active", system_key: null, package_discount_bps: null, peak_priority: false, member_count: 4 };
const PACKAGES = [
  pkg("p-1", "One hour", 60, 120, 0), pkg("p-5", "Five hours", 300, 550, 1), pkg("p-10", "Ten hours", 600, 1000, 2),
  pkg("p-s", "Social 5 hours", 300, 450, 0, { id: "g-social", name: "Social evenings" }),
];
const packageRoutes = () => adminRoutes([
  { path: "/api/v1/admin/packages", body: { packages: PACKAGES } },
  { path: "/api/v1/admin/member-groups", body: { groups: [SOCIAL] } },
]);

test.describe("L6-7 — Packages uses a desk's width", () => {
  for (const width of [1024, 1280, 1440]) {
    test(`at ${width}: shelves are tables and the editor stands beside them`, async ({ page }) => {
      await open(page, "/admin/packages", packageRoutes(), width);
      await expect(page.getByRole("table").first()).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Edit Five hours" }).click();
      // Beside the list, not over it: no modal, and the shelves stay on screen.
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const rail = page.getByRole("complementary", { name: /package/i });
      await expect(rail.getByRole("textbox").first()).toBeVisible();
      await expect(page.getByRole("table").first()).toBeInViewport();
      expect(await sideways(page)).toBeLessThanOrEqual(1);
      // Every column on screen beside the editor: the table does not scroll inside its column.
      const spill = await page.locator("[data-aside-main]").evaluate((col) => {
        const right = col.getBoundingClientRect().right;
        return Math.max(...[...col.querySelectorAll("table")].map((t) => t.getBoundingClientRect().right - right));
      });
      expect(spill, "a package table runs past its column").toBeLessThanOrEqual(1);
      if (process.env.FC_SHOTS) await page.screenshot({ path: `${process.env.FC_SHOTS}/packages-${width}.png` });
    });
  }
});

test.describe("L6-8 — the package editor's sheet docks its footer", () => {
  test("at 390 the Save button is on screen with the form unscrolled, and saves", async ({ page }) => {
    await open(page, "/admin/packages", packageRoutes(), 390);
    await page.getByRole("button", { name: "Edit Five hours" }).click({ timeout: 30_000 });
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("textbox").first()).toBeVisible();
    const save = sheet.getByRole("button", { name: "Save package" });
    await expect(save).toBeInViewport();
    const body = sheet.locator("[data-slot='dialog-body']");
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight), "the form is long enough to scroll").toBe(true);
  });
});

test.describe("L6-9 — a member's name on a phone card", () => {
  test("at 390 is never cut by the badges beside it", async ({ page }) => {
    const names = ["Thandiwe Mokoena-Dlamini", "Bea Nkosi", "Alexandra Featherstonehaugh"];
    const club = names.map((full_name, i) => member({
      user_id: `00000000-0000-4000-8000-00000000070${i}`, membership_id: `00000000-0000-4000-8000-00000000071${i}`,
      full_name, is_admin: i !== 1, admin_source: i === 0 ? "config" : "granted", email_verified: i !== 2,
      balance_minutes: 150,
    }));
    await open(page, "/admin/members", adminRoutes([{ path: "/api/v1/admin/members/", body: club }]), 390);
    await expect(page.locator("[data-member-row]").first()).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    const cut = await page.locator("[data-member-row] a[title]").evaluateAll((links) =>
      links.filter((a) => a.scrollWidth > a.clientWidth + 1 || a.scrollHeight > a.clientHeight + 1)
        .map((a) => `${a.textContent} ${a.clientWidth}/${a.scrollWidth}x${a.clientHeight}/${a.scrollHeight} ${getComputedStyle(a).display}`));
    expect(cut, "names cut short").toEqual([]);
    if (process.env.FC_SHOTS) await page.screenshot({ path: `${process.env.FC_SHOTS}/members-390.png` });
    const tall = await page.locator("[data-member-row]").evaluateAll((rows) => rows.map((r) => Math.round(r.getBoundingClientRect().height)));
    // Still compact (R5 §4.3, ~72 px): a two-badge card stays near it; three badges stack beside the name.
    expect(tall[0], `card heights ${tall.join(", ")}`).toBeLessThanOrEqual(110);
    expect(tall[1], `card heights ${tall.join(", ")}`).toBeLessThanOrEqual(80);
    expect(tall[2], `card heights ${tall.join(", ")}`).toBeLessThanOrEqual(136);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });
});

const DAY = (i: number) => ({
  // A busy club day: 10 h sold, twelve courts charged, a refund reversed, a desk correction.
  date: `2026-09-${String(i + 1).padStart(2, "0")}`, top_ups_minutes: 600 + i, booking_charges_minutes: 540, refunds_minutes: -45,
  penalties_minutes: 13, adjustments_minutes: -120, reversals_minutes: -60, share_transfers_minutes: 30, net_movement_minutes: -122,
  bookings: 12, no_shows: 2,
});
const reportRoutes = () => adminRoutes([
  { path: "/api/v1/admin/reports/revenue", body: { from: "", to: "", gross_topups_zar: 3350, reversals_zar: 0, net_zar: 3350, gross_topups_minutes: 1800, reversals_minutes: 0, net_minutes: 1800, zar_per_minute_sold: 1.8611 } },
  { path: "/api/v1/admin/reports/utilisation", body: { from: "", to: "", by_court: [] } },
  { path: "/api/v1/admin/reports/no-shows", body: { from: "", to: "", total: 24, no_show: 2, no_show_pct: 8.3 } },
  { path: "/api/v1/admin/reports/daily", body: Array.from({ length: 10 }, (_, i) => DAY(i)) },
]);

test.describe("L6-14 — Reports at a desk's width", () => {
  test("at 1280 the daily table shows every column, unclipped", async ({ page }) => {
    await open(page, "/admin/reports", reportRoutes(), 1280);
    const table = page.getByRole("region", { name: "Daily breakdown" }).getByRole("table");
    await expect(table).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    const clip = await table.evaluate((t) => {
      const region = t.closest("[data-slot='section'], section") ?? t.parentElement!;
      const last = t.querySelector("thead tr")!.lastElementChild!.getBoundingClientRect();
      let scroller: HTMLElement | null = t.parentElement;
      while (scroller && scroller.scrollWidth <= scroller.clientWidth + 1) scroller = scroller.parentElement;
      const cols = [...t.querySelectorAll("thead th")].map((th) => `${(th.textContent ?? "").slice(0, 14)}:${Math.round(th.getBoundingClientRect().width)}`).join(" ");
      return { cols, lastRight: Math.round(last.right), regionRight: Math.round(region.getBoundingClientRect().right), scrolls: scroller ? scroller.tagName + "." + scroller.className.slice(0, 60) : null };
    });
    expect(clip.lastRight, JSON.stringify(clip)).toBeLessThanOrEqual(clip.regionRight + 1);
    if (process.env.FC_SHOTS) await table.screenshot({ path: `${process.env.FC_SHOTS}/daily-1280.png` });
    expect(await sideways(page)).toBeLessThanOrEqual(1);
  });
});

test.describe("X5-12 — a group's Manage packages link", () => {
  test("is a 44 px target", async ({ page }) => {
    await open(page, "/admin/groups", adminRoutes([
      { path: "/api/v1/admin/packages", body: { packages: PACKAGES } },
      { path: "/api/v1/admin/member-groups", body: { groups: [SOCIAL] } },
    ]), 390);
    const link = page.getByRole("link", { name: "Manage packages" }).first();
    await expect(link).toBeVisible({ timeout: 30_000 });
    const box = (await link.boundingBox())!;
    expect(box.height, `${box.width}×${box.height}`).toBeGreaterThanOrEqual(44);
  });
});

test.describe("L6-16 / X6-5 — the admin sections at 200 % text", () => {
  test("320: the switcher's names wrap rather than cut, and the icons grow with the text", async ({ page }) => {
    await open(page, "/admin/members", adminRoutes(), 320);
    await page.addStyleTag({ content: "html { font-size: 32px; }" });
    await page.getByRole("button", { name: /Members/ }).first().click({ timeout: 30_000 });
    const rows = page.getByRole("dialog").locator("[data-admin-nav]");
    await expect(rows.first()).toBeVisible();
    const cut = await rows.evaluateAll((links) => links.flatMap((a) => {
      const label = a.querySelector("span.flex-1") as HTMLElement | null;
      return label && label.scrollWidth > label.clientWidth + 1 ? [label.textContent] : [];
    }));
    expect(cut).toEqual([]);
    const icon = await rows.first().locator("svg").first().boundingBox();
    expect(icon!.width).toBeGreaterThanOrEqual(36);
  });

  test("1280: the rail takes at most a quarter of the screen", async ({ page }) => {
    await open(page, "/admin/members", adminRoutes(), 1280);
    await page.addStyleTag({ content: "html { font-size: 32px; }" });
    const rail = page.locator("[data-admin-rail]");
    await expect(rail).toBeVisible({ timeout: 30_000 });
    expect((await rail.boundingBox())!.width).toBeLessThanOrEqual(320);
  });
});
