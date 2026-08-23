import { SESSION_ADMIN, serveApi, signIn, test, expect } from "./fixtures";

/**
 * What a member is shown about their money.
 *
 * <p>
 * Credits were rendered with a rand sign on six screens. At 1.6–2.4 credits per rand
 * that overstates a balance by 60% to 140% — the sort of defect a unit test on a
 * formatter can catch afterwards but that nobody noticed for months because it
 * <i>looked</i> like money.
 * </p>
 *
 * <p>
 * So this asserts on the rendered page rather than on a function: no rand sign
 * anywhere a credit figure appears.
 * </p>
 */
test("a credit balance is never shown with a rand sign", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/wallet", body: { balance_credits: 240, entries: [] } },
    { path: "/api/v1/me/profile", body: { full_name: "Test Member", email: "m@test.local", photo_url: null, membership_number: "P-1", member_class: "Regular" } },
  ]);

  await page.goto("/wallet");

  const header = page.locator("header");
  await expect(header).toContainText("240.00 cr");
  // The whole bug, in one assertion: 240 credits is R100 of top-up, not R240.
  await expect(header).not.toContainText("R240");
});


/**
 * The admin revenue tile, which is where the units were most expensive.
 *
 * <p>
 * The API sent credits under the names <code>gross_topups_zar</code> and
 * <code>net_zar</code>, and this page printed them with a rand sign. A Regular member's
 * R1000 top-up posts 1600 credits and a League member's posts 2400, so the club read
 * R1600–R2400 of income for R1000 actually banked — and once summed the two classes
 * could not be separated again.
 * </p>
 *
 * <p>
 * Net revenue is now genuinely rand, taken from what members paid; top-ups are shown in
 * credits and labelled as such. The two figures differing is the point of the test.
 * </p>
 */
test("club revenue reports rand as rand and credits as credits", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/me/profile", body: { full_name: "Club Admin", email: "a@test.local", photo_url: null, membership_number: "A-1", member_class: "Regular" } },
    { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [] } },
    { path: "/api/v1/reports/me/wallet", body: { from: "", to: "", top_ups_credits: 0, spent_credits: 0, refunds_credits: 0, penalty_count: 0, count: 0 } },
    { path: "/api/v1/reports/me/daily", body: [] },
    {
      path: "/api/v1/admin/reports/revenue",
      body: {
        from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z",
        gross_topups_zar: 1000, reversals_zar: 0, net_zar: 1000,
        gross_topups_credits: 1600, reversals_credits: 0, net_credits: 1600,
      },
    },
    { path: "/api/v1/admin/reports/utilisation", body: { from: "", to: "", by_court: [] } },
    { path: "/api/v1/admin/reports/no-shows", body: { from: "", to: "", total: 0, no_show: 0, no_show_pct: 0 } },
    { path: "/api/v1/admin/reports/daily", body: [] },
  ]);

  await page.goto("/reports");

  // R1000 banked, 1600 credits issued. Neither number wearing the other's unit.
  await expect(page.getByText("R1000.00")).toBeVisible();
  await expect(page.getByText("1600.00 cr")).toBeVisible();
  await expect(page.getByText("R1600")).toHaveCount(0);
});

/**
 * The admin ledger's totals, which were not merely mislabelled but blank.
 *
 * <p>
 * The API sent <code>signedAmountZar</code>; the page has always read
 * <code>signedAmountCredits</code>. So the field arrived undefined: every comparison
 * against it was false, every row rendered with a minus sign, and both totals summed to
 * zero. Renaming the field to the unit it actually holds fixed the lie and the blank
 * totals in one move.
 * </p>
 */
test("the admin ledger totals credits and debits apart", async ({ page }) => {
  await signIn(page);
  const row = (id: string, signed: number, type: string) => ({
    id, at: "2026-01-15T10:00:00Z", from: "Club", to: "Member",
    amountCredits: Math.abs(signed), signedAmountCredits: signed,
    type, comment: "", subjectUserId: "00000000-0000-0000-0000-000000000002",
    subjectName: "Test Member", actorUserId: "00000000-0000-0000-0000-000000000002",
    actorName: "Test Member", relatedBookingId: null,
  });

  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/me/profile", body: { full_name: "Club Admin", email: "a@test.local", photo_url: null, membership_number: "A-1", member_class: "Regular" } },
    { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [] } },
    { path: "/api/v1/admin/ledger/", body: [row("1", 160, "TopUp"), row("2", -50, "BookingCharge")] },
  ]);

  await page.goto("/admin/ledger");

  // Both totals populated — the state the undefined field could never reach — and both
  // in credits. Scoped to the summary paragraphs because the same figures appear again in
  // the table, which is the other half of the same fix.
  await expect(page.getByRole("paragraph").filter({ hasText: /^\+160\.00 cr$/ })).toBeVisible();
  await expect(page.getByRole("paragraph").filter({ hasText: /^−50\.00 cr$/ })).toBeVisible();

  // And the row itself: a top-up is a credit. Every row used to render with a minus sign,
  // because `undefined >= 0` is false for all of them.
  await expect(page.getByRole("cell", { name: "+160.00 cr" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "−50.00 cr" })).toBeVisible();
});
