import { SESSION_ADMIN, serveApi, signIn, test, expect } from "./fixtures";

/**
 * The club's book at the widths an admin actually uses — review round 2.
 *
 * <p>
 * F3-9: round 1 added Category and Done by, and at 1280 beside the admin rail the Amount and the
 * Details button were past the right edge of the table's scroller — the one column a ledger
 * exists for, one swipe away. F3-19: Details measured 42 × 36 at 390. F3-20: its sheet had two
 * buttons named "Close". F3-15: "Open the booking" read as plain text.
 * </p>
 */
const MEMBER = "00000000-0000-0000-0000-000000000002";
const row = (id: string, signed: number, over: Record<string, unknown> = {}) => ({
  id, at: "2026-01-15T10:00:00Z",
  from: signed >= 0 ? "Club treasury" : "Nomvula Dlamini-Hendricks", to: signed >= 0 ? "Nomvula Dlamini-Hendricks" : "Club treasury",
  amountMinutes: Math.abs(signed), signedAmountMinutes: signed, type: "BookingCharge",
  comment: "Court 3 · Thu 15 Jan, 18:00–19:30 — booked for the league fixture against the visiting side",
  subjectUserId: MEMBER, subjectName: "Nomvula Dlamini-Hendricks", actorUserId: MEMBER,
  actorName: "Nomvula Dlamini-Hendricks", relatedBookingId: "b0000000-0000-0000-0000-000000000001",
  ...over,
});

async function open(page: import("@playwright/test").Page) {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/me/profile", body: { full_name: "Club Admin", email: "a@test.local", photo_url: null, membership_number: "A-1" } },
    { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [] } },
    { path: "/api/v1/admin/ledger/", body: [row("1", -48), row("2", 200, { type: "AdminTopUp", actor_name: "Desk Volunteer", actorUserId: "00000000-0000-0000-0000-00000000000a" })] },
  ]);
  await page.goto("/admin/ledger?from=2026-01-01&to=2026-01-31");
  await expect(page.getByRole("table", { name: "Club ledger" })).toBeVisible();
}

test("keeps the Amount and the Details button inside the table at 1280 beside the rail", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "a desktop width");
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);

  const scroller = page.getByRole("region", { name: "Club ledger" });
  const box = (await scroller.boundingBox())!;
  const amount = (await page.getByRole("cell", { name: /minus 48 minutes|−48 min/ }).first().boundingBox())!;
  const details = (await page.getByRole("button", { name: /^Details — Booking charge/ }).boundingBox())!;
  expect(amount.x + amount.width, "the Amount is past the table's edge").toBeLessThanOrEqual(box.x + box.width + 1);
  expect(details.x + details.width, "Details is past the table's edge").toBeLessThanOrEqual(box.x + box.width + 1);
  expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});

test("gives Details a 44 px target, one Close, and a booking link that looks like one", async ({ page }) => {
  await open(page);
  const details = page.getByRole("button", { name: /^Details — Booking charge/ });
  const size = (await details.boundingBox())!;
  expect(size.width).toBeGreaterThanOrEqual(43.5);
  expect(size.height).toBeGreaterThanOrEqual(43.5);

  await details.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  // The sheet's × is "Close <title>"; the footer's way out is "Done" — never a second "Close".
  await expect(sheet.getByRole("button", { name: /^Close\b/ })).toHaveCount(1);
  await expect(sheet.getByRole("button", { name: "Done" })).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Open the booking" })).toHaveAttribute("data-text-link", "standalone");
});
