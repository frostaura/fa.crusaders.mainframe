import { expect, serveApi, signIn, test, type ApiRoute } from "./fixtures";
import { BOOKING, CLUB_ZONE, COURT, ME, PEOPLE, SAM, detailFixture, memberShellRoutes, tomorrowAt } from "./playersKit";
import { HELD_EXPLAINER, heldLine } from "../src/lib/playersCopy";
import { SHARE_LEDGER_COPY, spendableLine } from "../src/lib/walletCopy";
import { LEDGER_TYPE_LABEL } from "../src/lib/creditAdjustment";

/**
 * P11 — the wallet's half of players and splits (D11 §3a): the held line on the balance card,
 * a booking's shares gathered under one line that opens and links to the booking, and the
 * club's ledger filtered to shares.
 */

const B2 = "b0000000-0000-0000-0000-000000000002";

function ledgerRow(id: string, over: Record<string, unknown>) {
  return {
    id, at: new Date().toISOString(), from: "Club treasury", to: PEOPLE.me.name, amountCredits: 25, signedAmountCredits: 25,
    type: "ShareTransfer", comment: "Share of a split booking", subjectUserId: ME, subjectName: PEOPLE.me.name,
    actorUserId: SAM, actorName: PEOPLE.sam.name, relatedBookingId: BOOKING, ...over,
  };
}

const ENTRIES = [
  ledgerRow("s-sam", {}),
  ledgerRow("topup", { type: "TopUp", comment: "Wallet top-up · R100.00", from: "PayFast", relatedBookingId: null, amountCredits: 100, signedAmountCredits: 100, actorUserId: ME, actorName: PEOPLE.me.name }),
  ledgerRow("s-jo", { relatedBookingId: B2, signedAmountCredits: -25, from: PEOPLE.me.name, to: "Club treasury", actorUserId: ME, actorName: PEOPLE.me.name }),
];

/** Jo's booking, on which the member is the partner who paid a share. */
const JO_BOOKING = detailFixture({
  booking_id: B2, court_id: COURT, court_name: "Court 2", organiser: PEOPLE.jo,
  viewer: { role: "player", participant_id: "p-me" },
  players: [],
});

function walletRoutes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    ...extra,
    { path: `/api/v1/bookings/${BOOKING}`, body: detailFixture() },
    { path: `/api/v1/bookings/${B2}`, body: JO_BOOKING },
    ...memberShellRoutes({ wallet: { entries: ENTRIES, total_entries: ENTRIES.length } }),
  ];
}

test.describe("P11: the wallet, with shares", () => {
  test("says what is held, until when, and what can be spent", async ({ page }) => {
    await signIn(page);
    await serveApi(page, walletRoutes());
    await page.goto("/wallet");

    const held = page.locator("[data-held-line]");
    // In the club's zone, which the page learns from /me/profile: the spec's own process is not
    // in it, and a line built without it would expect the runner's clock face.
    await expect(held).toContainText(heldLine(20, tomorrowAt(20, 45), CLUB_ZONE));
    await expect(held).toContainText(spendableLine(100));
    await expect(held).toContainText(HELD_EXPLAINER);
    // The chip's name carries it too: the figure it shows is SPENDABLE (F1.11), and its name
    // also says the whole balance and what is held.
    await expect(page.locator("[data-credits-chip]")).toHaveAttribute("aria-label", /120\.00 credits, 20\.00 held for partners/);
  });

  test("gathers a booking's shares under one line that opens, and links to the booking", async ({ page }) => {
    await signIn(page);
    await serveApi(page, walletRoutes());
    await page.goto("/wallet");

    const organiser = page.getByRole("button", { name: /^Shares for Court 1 · .* from 1 partner/ });
    await expect(organiser).toBeVisible();
    await expect(organiser).toHaveAttribute("aria-expanded", "false");
    const rows = page.locator(`[data-share-group="${BOOKING}"] ~ [data-share-row]`).first();
    await expect(rows).toBeHidden();

    await organiser.click();
    await expect(organiser).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(/^Sam paid you 25\.00 cr for their share of Court 1/)).toBeVisible();

    // The partner's side of another booking reads as their share, not as a debt.
    const partner = page.getByRole("button", { name: /^Your share · Court 2 · / });
    await expect(partner).toBeVisible();
    await partner.click();
    await expect(page.getByText(/^25\.00 cr moved to Jo for your share of Court 2/)).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/owe|debt/i);

    // Every other movement is its own row.
    await expect(page.getByText("Wallet top-up · R100.00")).toBeVisible();

    const link = page.getByRole("link", { name: new RegExp(`^${SHARE_LEDGER_COPY.viewBooking}.*Shares for Court 1`) });
    await expect(link).toHaveAttribute("href", `/bookings/${BOOKING}`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/bookings/${BOOKING}$`));
  });

  test("says nothing about holds when nothing is held", async ({ page }) => {
    await signIn(page);
    await serveApi(page, [
      ...memberShellRoutes({ wallet: { held_credits: 0, spendable_credits: 120, held_until: null } }),
    ]);
    await page.goto("/wallet");
    await expect(page.getByText("No movements yet")).toBeVisible();
    await expect(page.locator("[data-held-line]")).toHaveCount(0);
  });
});

test.describe("P11: the club's ledger, filtered to shares", () => {
  test("lists shares by name, asks the API for them, and shows both legs", async ({ page }) => {
    await signIn(page);
    await serveApi(page, [
      {
        path: "/api/v1/admin/ledger",
        body: [ledgerRow("in", {}), ledgerRow("out", { subjectUserId: SAM, subjectName: PEOPLE.sam.name, signedAmountCredits: -25, from: PEOPLE.sam.name, to: "Club treasury" })],
      },
      ...memberShellRoutes({ admin: true }),
      { path: "/api/v1/admin/members", body: [] },
      { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    ]);
    await page.goto("/admin/ledger?from=2026-09-01&to=2026-12-31");
    await expect(page.getByRole("heading", { level: 1, name: "Transactions" })).toBeVisible();

    const asked = page.waitForRequest((req) => req.url().includes("/api/v1/admin/ledger") && req.url().includes("type=ShareTransfer"));
    await page.getByRole("combobox", { name: "Type" }).click();
    await page.getByRole("option", { name: LEDGER_TYPE_LABEL.ShareTransfer }).click();
    await expect(page).toHaveURL(/type=ShareTransfer/);
    await asked;
    await expect(page.getByText("Share of a split booking").first()).toBeVisible();
    // The club's book never groups: both legs are rows, and they net to zero.
    await expect(page.getByRole("button", { name: /Shares for|Your share/ })).toHaveCount(0);
    await expect(page.locator("[data-ledger-total]").last()).toHaveText("0.00 cr");
  });
});
