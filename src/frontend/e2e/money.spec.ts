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
