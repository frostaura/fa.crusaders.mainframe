import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { ADMIN_ROLE_COPY, DOORS_TAB_COPY, MEMBER_COPY, MEMBER_TABS } from "../src/lib/memberDetailCopy";

/**
 * The member page (P5, R17/R20/D9), driven in Chromium at both project widths.
 *
 * <p>
 * jsdom lays nothing out, so the things this file measures cannot be unit-tested: that the page
 * never scrolls sideways at 375px (the tab row scrolls inside itself instead), that every tab is
 * a 44px target, and that a tab is a real navigation — a URL, `aria-current`, Back.
 * </p>
 */

const MEMBER_ID = "bbbbbbbb-0000-4000-8000-00000000000b";
const BASE = `/api/v1/admin/members/${MEMBER_ID}`;

function detail(overrides: Record<string, unknown> = {}) {
  return {
    user_id: MEMBER_ID, membership_id: "cccccccc-0000-4000-8000-00000000000c",
    full_name: "Naledi Khumalo-Van der Merwe", email: "naledi.khumalo@example.com", membership_number: "CR-2026-0184",
    status: "Active", account_status: "Active", email_verified: true,
    created_at: "2026-03-01T08:00:00Z", last_login_at: "2026-09-22T17:30:00Z", photo_url: null,
    is_admin: false, admin_source: null,
    groups: [{ id: "g1", name: "League" }, { id: "g2", name: "Juniors coaching" }],
    balance_credits: -16,
    passkey_count: 1,
    fingerprints: { count: 1, enrolments: [{ template_id: "t1", finger_label: "right-index", enrolled_at: "2026-04-02T10:00:00Z" }] },
    next_bookings: [{
      booking_id: "b1", court_id: "c1", court_name: "Court 2", starts_at: "2099-09-23T16:00:00Z", ends_at: "2099-09-23T16:45:00Z",
      status: "booked", charged_credits: 24, checked_in_at: null, cancelled_at: null,
      booked_by: { user_id: SESSION_ADMIN.user_id, name: "Crusaders Admin", is_self: false },
    }],
    counts_30d: { bookings: 6, no_shows: 1, sessions_played: 5 },
    ...overrides,
  };
}

function routes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/wallet", body: { balance_credits: 10, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@test.local", photo_url: null, membership_number: "A-1" } },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/doors", body: { day_started_at: "2026-09-23T00:00:00+02:00", timezone: "Africa/Johannesburg", shut_all_active: false, doors: [] } },
    { path: BASE, body: detail() },
    {
      path: `${BASE}/doors`,
      body: {
        member: { user_id: MEMBER_ID, name: "Naledi" },
        items: [{
          at: "2026-09-22T16:02:00Z", delivered_at: null, time_uncertain: false, action: "gate.released", outcome: "released",
          reason: null, reason_text: "Opened — a live booking", offline: false, method: "qr", fingerprint: null,
          door: { id: "d1", name: "Front door", gate_key: "front", removed: false },
        }],
        next_cursor: null, total: 1, range: { from: "2026-09-16T00:00:00+02:00", to: "2026-09-23T10:00:00+02:00" },
        timezone: "Africa/Johannesburg", retention_days: 90,
      },
    },
    {
      path: `${BASE}/trace`,
      body: { member: { user_id: MEMBER_ID, name: "Naledi" }, timezone: "Africa/Johannesburg", events: [], retention: {} },
    },
    ...extra,
  ];
}

test.describe("member detail", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("never scrolls the page sideways, and every tab is a 44px link", async ({ page }) => {
    await serveApi(page, routes());
    await page.goto(`/admin/members/${MEMBER_ID}`);
    await expect(page.getByRole("heading", { level: 1, name: "Naledi Khumalo-Van der Merwe" })).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    const nav = page.getByRole("navigation", { name: MEMBER_COPY.tabsLabel });
    for (const tab of MEMBER_TABS) {
      const box = await nav.getByRole("link", { name: tab.label }).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByTestId("member-balance")).toHaveText("-16.00 cr");
  });

  test("a tab is a real navigation: a URL, aria-current, and Back", async ({ page }) => {
    await serveApi(page, routes());
    await page.goto(`/admin/members/${MEMBER_ID}`);
    const nav = page.getByRole("navigation", { name: MEMBER_COPY.tabsLabel });

    await nav.getByRole("link", { name: "Door history" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/members/${MEMBER_ID}/doors$`));
    await expect(nav.getByRole("link", { name: "Door history" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText(DOORS_TAB_COPY.audited).first()).toBeVisible();
    await expect(page.getByText("Front door")).toBeVisible();

    await page.goBack();
    await expect(nav.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  });

  test("grants admin only through the confirm dialog, which always has a ×", async ({ page }) => {
    const posted: unknown[] = [];
    await serveApi(page, routes([
      {
        method: "POST", path: `${BASE}/admin`,
        respond: ({ body }) => { posted.push(body); return { user_id: MEMBER_ID, is_admin: true, admin_source: "granted", changed: true }; },
      },
    ]));
    await page.goto(`/admin/members/${MEMBER_ID}/access`);

    await page.getByRole("switch", { name: ADMIN_ROLE_COPY.label }).click();
    const dialog = page.getByRole("dialog", { name: ADMIN_ROLE_COPY.grantTitle("Naledi Khumalo-Van der Merwe") });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
    expect(posted).toHaveLength(0);

    await dialog.getByRole("button", { name: ADMIN_ROLE_COPY.grantConfirm }).click();
    await expect(dialog).toBeHidden();
    expect(posted).toEqual([{ grant: true }]);
  });
});
