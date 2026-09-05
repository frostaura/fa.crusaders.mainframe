import { SESSION_ADMIN, serveApi, signIn, test, expect } from "./fixtures";

/**
 * §8's override, offered to the one wallet it can never be applied to.
 *
 * <p>
 * <b>Why this is a browser spec and not another vitest case.</b> It was found in a headed
 * browser, twice, from a clean modal each time, and the defect is a sequence of screen states
 * rather than a return value: the modal renders the full offer, the second press is refused,
 * the figures are discarded, the button reverts, and the toast sends the admin back to look at
 * figures that are no longer there. A component test can assert the first frame of that; only a
 * real render loop can show that pressing the button leads back to where it started.
 * </p>
 *
 * <p>
 * The member picker is populated from <code>/api/v1/admin/members</code> and lists the
 * signed-in admin along with everybody else — in the running club "Crusaders Admin" is the
 * first name in the dropdown. The server's override is
 * <code>payer.AllowNegativeBalance &amp;&amp; actorId != userId</code>
 * (<code>BookingService</code>), so choosing yourself can only ever be refused. That guard is
 * right and stays; what was wrong was offering the override in front of it.
 * </p>
 *
 * <p>
 * No money moves in either version — this is a copy and affordance defect, not a settlement
 * one. The spec asserts exactly one POST for exactly that reason.
 * </p>
 */

const COURT = "aaaaaaaa-0000-4000-8000-00000000000c";
const ADMIN_ID = SESSION_ADMIN.user_id;
const MEMBER_ID = "bbbbbbbb-0000-4000-8000-00000000000b";

/** Tomorrow, so every slice on the grid is in the future whatever time this runs at. */
function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const day = () => ({
  date: tomorrow(),
  timezone: "UTC",
  sliceMinutes: 15,
  dayStartMinute: 7 * 60,
  dayEndMinute: 20 * 60,
  advanceBookingDays: 14,
  penaltyPct: 30,
  penaltyWindowMinutes: 15,
  courts: [{ id: COURT, courtNumber: 1, name: "Court 1", slicePriceCredits: 50 }],
  slots: [],
});

const SHORT = { error: "insufficient_balance", current_credits: 10, required_credits: 50 };

test("the admin override is not offered when the admin picks their own name", async ({ page }) => {
  await signIn(page);
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/v1/admin/bookings")) posts.push(r.url());
  });

  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [] } },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@test.local", photo_url: null, membership_number: "A-1", member_class: "Regular" } },
    { path: "/api/v1/admin/members", body: [
      { user_id: ADMIN_ID, full_name: "Crusaders Admin" },
      { user_id: MEMBER_ID, full_name: "Naledi Khumalo" },
    ] },
    { path: "/api/v1/schedule", body: day() },
    { method: "POST", path: "/api/v1/admin/bookings", status: 402, body: SHORT },
  ]);

  await page.goto("/schedule");

  await page.getByRole("button", { name: /^Book Court 1 .* for 50\.00 cr/ }).first().click();
  const modal = page.getByRole("dialog", { name: "Confirm booking" });
  await expect(modal).toBeVisible();

  await modal.getByLabel("Book this as").selectOption("member");
  await modal.getByLabel("Member").selectOption(ADMIN_ID);
  await modal.getByRole("button", { name: "Book for 50.00 cr" }).click();

  // The sentence that ends the interaction, rather than the offer that restarts it.
  await expect(page.getByText(/only works on another member's wallet/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Book anyway/ })).toHaveCount(0);
  await expect(page.getByText(/Try again to see what they're short by/)).toHaveCount(0);

  // One attempt. The old screen's loop had no exit and every lap was another POST.
  expect(posts).toHaveLength(1);
});

/**
 * The control: the same screen, the same refusal, a DIFFERENT member. §8's override must still
 * be offered here with the figures on it, or this fix would have closed the feature instead of
 * the dead end.
 */
test("the override is still offered when the payer is somebody else", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [] } },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@test.local", photo_url: null, membership_number: "A-1", member_class: "Regular" } },
    { path: "/api/v1/admin/members", body: [
      { user_id: ADMIN_ID, full_name: "Crusaders Admin" },
      { user_id: MEMBER_ID, full_name: "Naledi Khumalo" },
    ] },
    { path: "/api/v1/schedule", body: day() },
    { method: "POST", path: "/api/v1/admin/bookings", status: 402, body: SHORT },
  ]);

  await page.goto("/schedule");

  await page.getByRole("button", { name: /^Book Court 1 .* for 50\.00 cr/ }).first().click();
  const modal = page.getByRole("dialog", { name: "Confirm booking" });
  await modal.getByLabel("Book this as").selectOption("member");
  await modal.getByLabel("Member").selectOption(MEMBER_ID);
  await modal.getByRole("button", { name: "Book for 50.00 cr" }).click();

  await expect(modal).toContainText("Naledi Khumalo doesn't have enough credit");
  await expect(page.getByRole("button", { name: "Book anyway — leaves -40.00 cr" })).toBeVisible();
});
