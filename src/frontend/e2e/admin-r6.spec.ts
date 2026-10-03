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
