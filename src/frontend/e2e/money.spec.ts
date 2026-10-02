import { SESSION_ADMIN, serveApi, signIn, test, expect } from "./fixtures";

/**
 * What a member is shown about their money.
 *
 * <p>
 * The wallet holds MINUTES (P13); rand is only what a package costs and what the club banked.
 * Credits were once rendered with a rand sign on six screens — the sort of defect a unit test on
 * a formatter catches afterwards but nobody noticed for months because it <i>looked</i> like
 * money. The two units must never wear each other's clothes.
 * </p>
 *
 * <p>
 * So this asserts on the rendered page rather than on a function: no rand sign
 * anywhere a minutes figure appears, and no decimals on minutes.
 * </p>
 */
// The app chrome is the page's `banner` landmark. Not `locator("header")`: since R11 every page
// carries its own <header> (PageHeader, inside <main>, so not a banner), and "the header" is no
// longer one element.
test("a minutes balance is never shown with a rand sign or a decimal", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/wallet", body: { balance_minutes: 240, entries: [] } },
    { path: "/api/v1/me/profile", body: { full_name: "Test Member", email: "m@test.local", photo_url: null, membership_number: "P-1" } },
  ]);

  await page.goto("/wallet");

  const header = page.getByRole("banner");
  await expect(header).toContainText("4 h");
  await expect(header).not.toContainText("R240");
  await expect(header).not.toContainText("240.00");
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
test("club revenue reports rand as rand and minutes as minutes", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/me/profile", body: { full_name: "Club Admin", email: "a@test.local", photo_url: null, membership_number: "A-1" } },
    { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [] } },
    { path: "/api/v1/reports/me/wallet", body: { from: "", to: "", top_ups_minutes: 0, spent_minutes: 0, refunds_minutes: 0, penalty_count: 0, count: 0 } },
    { path: "/api/v1/reports/me/daily", body: [] },
    {
      path: "/api/v1/admin/reports/revenue",
      body: {
        from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z",
        gross_topups_zar: 1000, reversals_zar: 0, net_zar: 1000,
        gross_topups_minutes: 1600, reversals_minutes: 0, net_minutes: 1600,
      },
    },
    { path: "/api/v1/admin/reports/utilisation", body: { from: "", to: "", by_court: [] } },
    { path: "/api/v1/admin/reports/no-shows", body: { from: "", to: "", total: 0, no_show: 0, no_show_pct: 0 } },
    { path: "/api/v1/admin/reports/daily", body: [] },
  ]);

  await page.goto("/reports");

  // R1000 banked, 1600 minutes sold. Neither number wearing the other's unit.
  await expect(page.getByText("R1000.00").first()).toBeVisible();
  await expect(page.getByText("1 d 2 h 40 min").first()).toBeVisible();
  await expect(page.getByText("R1600")).toHaveCount(0);
  await expect(page.getByText(/1600\.00/)).toHaveCount(0);
});

/**
 * The admin ledger's totals, which were not merely mislabelled but blank.
 *
 * <p>
 * The API sent <code>signedAmountZar</code>; the page has always read
 * <code>signedAmountMinutes</code>. So the field arrived undefined: every comparison
 * against it was false, every row rendered with a minus sign, and both totals summed to
 * zero. Renaming the field to the unit it actually holds fixed the lie and the blank
 * totals in one move.
 * </p>
 */
test("the admin ledger totals what came in and what went out apart", async ({ page }) => {
  await signIn(page);
  const row = (id: string, signed: number, type: string) => ({
    id, at: "2026-01-15T10:00:00Z", from: "Club", to: "Member",
    amountMinutes: Math.abs(signed), signedAmountMinutes: signed,
    type, comment: "", subjectUserId: "00000000-0000-0000-0000-000000000002",
    subjectName: "Test Member", actorUserId: "00000000-0000-0000-0000-000000000002",
    actorName: "Test Member", relatedBookingId: null,
  });

  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/me/profile", body: { full_name: "Club Admin", email: "a@test.local", photo_url: null, membership_number: "A-1" } },
    { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [] } },
    { path: "/api/v1/admin/ledger/", body: [row("1", 160, "TopUp"), row("2", -50, "BookingCharge")] },
  ]);

  await page.goto("/admin/ledger");

  // Both totals populated — the state the undefined field could never reach — in minutes.
  await expect(page.getByText("+2 h 40 min").first()).toBeVisible();
  await expect(page.getByText("−50 min").first()).toBeVisible();

  // And the rows themselves: a purchase is money IN. Every row used to render with a minus
  // sign, because `undefined >= 0` is false for all of them.
  await expect(page.getByRole("cell", { name: /\+2 h 40 min|plus 2 hours 40 minutes/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /−50 min|minus 50 minutes/ })).toBeVisible();
});

/**
 * The club's own currency symbol, end to end — and the boundary it does not cross.
 *
 * <p>
 * The owner asked for the <code>cr</code> suffix to be replaced by a configurable symbol
 * preceding the amount. It governs RAND, because a member pays R100 and receives
 * <code>credits_per_zar_regular</code> × 100 credits — shipped at 1.6 — so the two are
 * different sizes. This is the same assertion the first test in this file makes, with the
 * symbol made configurable: whatever the club sets, it reaches money and stops there.
 * </p>
 *
 * <p>
 * Driven through the real channel rather than a formatter: the symbol rides on
 * <code>/me/profile</code>, so this proves the whole path — payload, provider, module store,
 * formatter, screen.
 * </p>
 */
test("the club's currency symbol reaches money and never a minutes figure", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    {
      path: "/api/v1/me/profile",
      body: {
        full_name: "Club Admin", email: "a@test.local", photo_url: null,
        membership_number: "A-1",
        currency_symbol: "CHF",
      },
    },
    { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [] } },
    { path: "/api/v1/reports/me/wallet", body: { from: "", to: "", top_ups_minutes: 0, spent_minutes: 0, refunds_minutes: 0, penalty_count: 0, count: 0 } },
    { path: "/api/v1/reports/me/daily", body: [] },
    {
      path: "/api/v1/admin/reports/revenue",
      body: {
        from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z",
        gross_topups_zar: 1000, reversals_zar: 0, net_zar: 1000,
        gross_topups_minutes: 1600, reversals_minutes: 0, net_minutes: 1600,
      },
    },
    { path: "/api/v1/admin/reports/utilisation", body: { from: "", to: "", by_court: [] } },
    { path: "/api/v1/admin/reports/no-shows", body: { from: "", to: "", total: 0, no_show: 0, no_show_pct: 0 } },
    { path: "/api/v1/admin/reports/daily", body: [] },
  ]);

  await page.goto("/reports");

  // The money figure wears the club's symbol, in front of the amount.
  await expect(page.getByText("CHF1000.00").first()).toBeVisible();
  // The rand sign is gone from this club entirely — it is not this club's currency.
  await expect(page.getByText("R1000.00")).toHaveCount(0);

  // And the minutes figure beside it is untouched by the symbol.
  await expect(page.getByText("1 d 2 h 40 min").first()).toBeVisible();
  await expect(page.getByText("CHF1600")).toHaveCount(0);
});

/**
 * The wallet chip's spoken name survives the symbol.
 *
 * <p>
 * An <code>aria-label</code> is what a screen reader announces INSTEAD of the element's
 * contents, so the chip's label spells the time out ("4 hours") where the chip shows "4 h". A
 * currency symbol would be worse: "CHF240" is announced as letters followed by a number, and it
 * would be the wrong quantity as well as the wrong sound.
 * </p>
 */
test("the wallet chip still speaks a word when the club has a symbol", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/wallet", body: { balance_minutes: 240, entries: [] } },
    {
      path: "/api/v1/me/profile",
      body: {
        full_name: "Test Member", email: "m@test.local", photo_url: null,
        membership_number: "P-1",
        currency_symbol: "CHF",
      },
    },
  ]);

  await page.goto("/wallet");

  const chip = page.getByRole("banner").locator("[aria-label*='Wallet balance']");
  await expect(chip).toHaveAttribute("aria-label", /4 hours/);
  await expect(chip).not.toHaveAttribute("aria-label", /CHF/);
  // The visible chip says time too — the symbol is money's, and this is not.
  await expect(page.getByRole("banner")).toContainText("4 h");
  await expect(page.getByRole("banner")).not.toContainText("CHF240");
});
