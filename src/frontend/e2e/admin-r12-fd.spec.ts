import { type Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { memberShellRoutes } from "./playersKit";
import { sideways } from "./layoutKit";

test.describe.configure({ timeout: 120_000 });

/**
 * Review round 12, lane FD12 — measured in Chromium against a mocked API: the last page of a paged
 * list hands focus to its first new row (X12-2), and a reversal that collided says so on the Night
 * without pushing a 320 phone sideways at 200 % text (E12-4).
 */

const USER = "00000000-0000-4000-8000-000000001201";

const member = {
  user_id: USER, membership_id: "00000000-0000-4000-8000-000000001211", full_name: "Thandi Mokoena",
  email: "thandi@r12.review.test", membership_number: "MEM-1201", status: "Active", email_verified: true,
  balance_minutes: 540, created_at: "2026-09-01T08:00:00Z", photo_url: null, is_admin: false, admin_source: null, groups: [],
};
const memberDetail = {
  ...member, account_status: "active", last_login_at: null, passkey_count: 0,
  fingerprints: { count: 0, enrolments: [] }, next_bookings: [], counts_30d: { bookings: 0, no_shows: 0, sessions_played: 0 },
};

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
    { path: "/api/v1/admin/members/", body: [member] },
  ];
}

async function open(page: Page, path: string, routes: ApiRoute[], width: number, height = 800) {
  await page.setViewportSize({ width, height });
  await signIn(page);
  await serveApi(page, routes);
  await page.goto(path);
}

const focusedText = (page: Page, selector: string) => page.evaluate((sel) => {
  const el = document.activeElement;
  if (!el || el === document.body) return "<body>";
  return el.closest(sel)?.textContent ?? `outside: ${el.tagName}`;
}, selector);

const doorRow = (at: string, reason: string) => ({
  at, delivered_at: at, time_uncertain: false, action: "gate.released", outcome: "released", reason: null,
  reason_text: reason, offline: false, method: "qr", fingerprint: null,
  door: { id: "d1", name: "Front door", gate_key: "front", removed: false },
});
const doorsPage = (items: unknown[], next: string | null) => ({
  member: { user_id: USER, name: "Thandi Mokoena" }, items, next_cursor: next, total: 2,
  range: { from: "2026-09-16T00:00:00+02:00", to: "2026-09-23T10:00:00+02:00" }, timezone: "Africa/Johannesburg", retention_days: 90,
});

test("X12-2 — the member Doors tab's last \"Load older scans\" hands focus to the first older scan", async ({ page }) => {
  await open(page, `/admin/members/${USER}/doors`, adminRoutes([
    { path: `/api/v1/admin/members/${USER}/doors`, body: doorsPage([doorRow("2026-09-22T16:02:00Z", "Opened — a live booking")], "D2") },
    { path: `/api/v1/admin/members/${USER}`, body: memberDetail },
  ]), 390, 844);
  await page.route(/\/doors\?.*cursor=D2/, (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify(doorsPage([doorRow("2026-09-20T09:00:00Z", "An older scan")], null)),
  }));
  const more = page.getByRole("button", { name: "Load older scans" });
  await more.focus({ timeout: 45_000 });
  await page.keyboard.press("Enter");
  await expect(more).toHaveCount(0);
  await expect.poll(() => focusedText(page, "[data-member-doors] > li")).toContain("An older scan");
});

test("X12-2 — the inbox's last \"Show more\" hands focus to the first older notice", async ({ page }) => {
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const notice = (id: string, headline: string, link: string | null) => ({ id, kind: "players.reminder", headline, link, booking_id: null, created_at: at, read_at: at });
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await serveApi(page, [
    ...memberShellRoutes({ unread: 0 }),
    { path: "/api/v1/me/notifications", body: { items: [notice("n1", "The newest notice", "/bookings/b1")], unread_count: 0, next_cursor: "N2" } },
  ]);
  await page.route(/\/me\/notifications\?.*cursor=N2/, (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ items: [notice("n9", "An older notice", null)], unread_count: 0, next_cursor: null }),
  }));
  await page.goto("/inbox");
  const more = page.getByRole("button", { name: "Show more" });
  await more.focus({ timeout: 45_000 });
  await page.keyboard.press("Enter");
  await expect(more).toHaveCount(0);
  await expect.poll(() => focusedText(page, "[data-inbox-list] > li")).toContain("An older notice");
});

const reversal = {
  at: "2026-09-22T16:20:00.000Z", strand: "booking", kind: "booking.no_show_reversed",
  headline: "The no-show was reversed — Thandi checked in at Court 2 after all",
  actor: { kind: "system", name: null }, subject: { user_id: USER, name: "Thandi Mokoena" },
  detail: { collision_booking_ids: ["b0000000-0000-0000-0000-000000000077"], collision_from: "2026-09-22T16:30:00Z" },
};
const night = {
  member: { user_id: USER, name: "Thandi Mokoena", membership_number: "MEM-1201" }, club_day: "2026-09-22",
  range: { from: "2026-09-22T00:00:00+02:00", to: "2026-09-23T00:00:00+02:00" }, timezone: "Africa/Johannesburg",
  retention: { audit_days: 730, door_days: 90, door_horizon: "2026-06-24", door_rows_may_be_incomplete: false },
  events: [reversal], total: 1, cursor: null,
};

for (const width of [320, 390]) {
  test(`E12-4 — a collided reversal says so on the Night, at ${width} and 200 % text`, async ({ page }) => {
    await open(page, `/admin/members/${USER}/night?day=2026-09-22`, adminRoutes([
      { path: `/api/v1/admin/members/${USER}/trace`, body: night },
      { path: `/api/v1/admin/members/${USER}`, body: memberDetail },
    ]), width, 844);
    const note = page.locator("[data-night-collision]");
    await expect(note).toContainText("from 18:30, so both paid for that time.", { timeout: 45_000 });
    await expect(note.getByRole("link", { name: "Open the other booking" })).toHaveAttribute("href", "/bookings/b0000000-0000-0000-0000-000000000077");
    await page.addStyleTag({ content: "html { font-size: 32px; }" });
    await page.evaluate(() => document.fonts.ready);
    expect(await sideways(page)).toBeLessThanOrEqual(1);
    const box = await note.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    if (process.env.FD_SHOTS) await page.locator("[data-night-row]").first().screenshot({ path: `${process.env.FD_SHOTS}/r12-collision-${width}.png` });
  });
}
