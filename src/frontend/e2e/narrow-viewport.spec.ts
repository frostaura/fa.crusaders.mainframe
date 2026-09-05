import { SESSION_ADMIN, serveApi, signIn, test, expect } from "./fixtures";

/**
 * E-F18 — the wallet ledger on a 375px phone.
 *
 * <p>
 * The finding was that the Amount column — the one figure a member opens their wallet to read —
 * sat off the right edge at 375px with nothing to say it was there. Two rounds of fixes went in
 * on the strength of the second half of that claim (the missing affordance, now `ScrollArea`)
 * while the first half was never measured: the columns were already responsive, and no run in
 * either round opened the page at 375px and looked.
 * </p>
 *
 * <p>
 * So this measures. It is a browser test rather than a jsdom one because jsdom has no layout
 * engine at all — every `getBoundingClientRect` there is zero, so a unit test literally cannot
 * see this class of defect, which is why the original claim survived two rounds unsettled.
 * </p>
 */

const AT = "2026-09-05T08:15:00Z";

const row = (id: string, signed: number, comment: string) => ({
  id,
  at: AT,
  from: signed >= 0 ? "PayFast top-up" : "Nomsa Khumalo",
  to: signed >= 0 ? "Nomsa Khumalo" : "Court 3 · 18:00",
  amountCredits: Math.abs(signed),
  signedAmountCredits: signed,
  type: signed >= 0 ? "TopUp" : "BookingCharge",
  comment,
  subjectUserId: "00000000-0000-0000-0000-000000000002",
  subjectName: "Nomsa Khumalo",
  actorUserId: "00000000-0000-0000-0000-000000000002",
  actorName: "Nomsa Khumalo",
  relatedBookingId: null,
});

const LEDGER = [
  row("1", 1600, "Top-up of R1000.00 at 1.60 credits per rand"),
  row("2", -137.5, "Court 3, 18:00-19:00, peak rate"),
  row("3", -1250.75, "Court 1, 06:00-08:00, off-peak block booking"),
  row("4", 62.5, "Late-cancellation refund less penalty"),
];

test.use({ viewport: { width: 375, height: 812 } });

test("every wallet ledger column a member needs is on screen at 375px", async ({ page }) => {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    {
      path: "/api/v1/wallet",
      body: { balance_credits: 274.25, entries: LEDGER, total_entries: LEDGER.length, offset: 0, limit: 50 },
    },
    {
      path: "/api/v1/me/profile",
      body: {
        full_name: "Nomsa Khumalo", email: "n@test.local", photo_url: null,
        membership_number: "P-1", member_class: "Regular",
      },
    },
  ]);

  await page.goto("/wallet");
  await expect(page.getByRole("region", { name: "Wallet ledger" })).toBeVisible();

  // The three columns that survive the sm breakpoint. From and To are deliberately dropped on a
  // phone (the counterparty rides under the amount instead), so they are not expected here.
  for (const header of ["Time", "Amount", "Comment"]) {
    await expect(page.getByRole("button", { name: header, exact: true })).toBeVisible();
  }

  // The measurement, not an impression: every rendered amount cell must end inside the viewport.
  const overflowing = await page.evaluate(() => {
    const width = window.innerWidth;
    const cells = [...document.querySelectorAll("table tbody tr")].map((tr) => {
      const amount = tr.querySelector<HTMLElement>("td.text-right");
      const box = amount?.getBoundingClientRect();
      return { text: amount?.textContent ?? "", left: box?.left ?? 0, right: box?.right ?? 0 };
    });
    return { width, offScreen: cells.filter((c) => c.right > width + 0.5 || c.left < -0.5), total: cells.length };
  });

  expect(overflowing.total).toBe(LEDGER.length);
  expect(overflowing.offScreen, "amount cells rendered outside the 375px viewport").toEqual([]);

  // And the amounts are readable as text, not merely present in the DOM.
  // U+2212 MINUS, not a hyphen — `formatSignedCredits` uses it so a debit lines up under a
  // credit in the tabular-nums column.
  await expect(page.getByText("+1600.00 cr", { exact: false })).toBeVisible();
  await expect(page.getByText("\u22121250.75 cr", { exact: false })).toBeVisible();
});

test("the page itself never scrolls sideways at 375px", async ({ page }) => {
  // The other half of the original claim: a table wider than the phone must scroll inside its
  // own region, not drag the whole document sideways. A horizontally scrolling body is how a
  // member loses the header and the navigation as well as the column.
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    {
      path: "/api/v1/wallet",
      body: { balance_credits: 274.25, entries: LEDGER, total_entries: LEDGER.length, offset: 0, limit: 50 },
    },
    {
      path: "/api/v1/me/profile",
      body: {
        full_name: "Nomsa Khumalo", email: "n@test.local", photo_url: null,
        membership_number: "P-1", member_class: "Regular",
      },
    },
  ]);

  await page.goto("/wallet");
  await expect(page.getByRole("region", { name: "Wallet ledger" })).toBeVisible();

  const doc = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth + 1);
});
