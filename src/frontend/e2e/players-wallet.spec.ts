import { expect, serveApi, signIn, test, type ApiRoute } from "./fixtures";
import { BOOKING, CLUB_ZONE, COURT, ME, PEOPLE, SAM, detailFixture, memberShellRoutes, tomorrowAt } from "./playersKit";
import { HELD_EXPLAINER, heldLine } from "../src/lib/playersCopy";
import { SHARE_LEDGER_COPY, spendableLine } from "../src/lib/walletCopy";
import { LEDGER_TYPE_LABEL } from "../src/lib/deskLedger";

/**
 * P11 — the wallet's half of players and splits (D11 §3a): the held line on the balance card,
 * a booking's shares gathered under one line that opens and links to the booking, and the
 * club's ledger filtered to shares.
 */

const B2 = "b0000000-0000-0000-0000-000000000002";

function ledgerRow(id: string, over: Record<string, unknown>) {
  return {
    id, at: new Date().toISOString(), from: "Club treasury", to: PEOPLE.me.name, amountMinutes: 25, signedAmountMinutes: 25,
    type: "ShareTransfer", comment: "Share of a split booking", subjectUserId: ME, subjectName: PEOPLE.me.name,
    actorUserId: SAM, actorName: PEOPLE.sam.name, relatedBookingId: BOOKING, ...over,
  };
}

const ENTRIES = [
  ledgerRow("s-sam", {}),
  ledgerRow("topup", { type: "TopUp", comment: "Wallet top-up · R100.00", from: "PayFast", relatedBookingId: null, amountMinutes: 100, signedAmountMinutes: 100, actorUserId: ME, actorName: PEOPLE.me.name }),
  ledgerRow("s-jo", { relatedBookingId: B2, signedAmountMinutes: -25, from: PEOPLE.me.name, to: "Club treasury", actorUserId: ME, actorName: PEOPLE.me.name }),
];

/** Jo's booking, on which the member is the partner who paid a share. */
const JO_BOOKING = detailFixture({
  booking_id: B2, court_id: COURT, court_name: "Court 2", organiser: PEOPLE.jo,
  viewer: { role: "player", participant_id: "p-me" },
  players: [],
});

type Detail = ReturnType<typeof detailFixture>;
type Seat = { kind: string; user_id: string | null; name: string | null; paid_minutes: number };

/** What `GET /wallet?include=share_bookings` says about a booking (perf round, 2026-09-30). */
function summaryOf(d: Detail) {
  const organiser = d.organiser as { user_id: string; name: string; photo_url: string | null };
  return {
    booking_id: d.booking_id, court_name: d.court_name, starts_at: d.starts_at, organiser,
    partners: (d.players as Seat[]).filter((p) => p.kind === "member" && p.user_id && p.user_id !== organiser.user_id)
      .map((p) => ({ user_id: p.user_id, name: p.name, paid_minutes: p.paid_minutes })),
  };
}

function walletRoutes(extra: ApiRoute[] = []): ApiRoute[] {
  return [
    ...extra,
    // The booking's own page, for the link below — never read to draw the wallet's share lines.
    { path: `/api/v1/bookings/${BOOKING}`, body: detailFixture() },
    ...memberShellRoutes({ wallet: {
      entries: ENTRIES, total_entries: ENTRIES.length,
      share_bookings: { [BOOKING]: summaryOf(detailFixture()), [B2]: summaryOf(JO_BOOKING) },
    } }),
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
    await expect(page.locator("[data-minutes-chip]")).toHaveAttribute("aria-label", /2 hours, 20 minutes held for partners/);
  });

  test("gathers a booking's shares under one line that opens, and links to the booking", async ({ page }) => {
    await signIn(page);
    await serveApi(page, walletRoutes());
    const bookingReads: string[] = [];
    page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/v1/bookings/")) bookingReads.push(r.url()); });
    await page.goto("/wallet");

    const organiser = page.getByRole("button", { name: /^Shares for Court 1 · .* from 1 partner/ });
    await expect(organiser).toBeVisible();
    await expect(organiser).toHaveAttribute("aria-expanded", "false");
    const rows = page.locator(`[data-share-group="${BOOKING}"] ~ [data-share-row]`).first();
    await expect(rows).toBeHidden();

    await organiser.click();
    await expect(organiser).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(/^Sam paid you 25 minutes for their share of Court 1/)).toBeVisible();

    // The partner's side of another booking reads as their share, not as a debt.
    const partner = page.getByRole("button", { name: /^Your share · Court 2 · / });
    await expect(partner).toBeVisible();
    await partner.click();
    await expect(page.getByText(/^25 minutes moved to Jo for your share of Court 2/)).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/owe|debt/i);

    // Every other movement is its own row.
    await expect(page.getByText("Wallet top-up · R100.00")).toBeVisible();
    // Perf round: the lines came with the ledger read — not one booking read per line.
    expect(bookingReads).toEqual([]);

    const link = page.getByRole("link", { name: new RegExp(`^${SHARE_LEDGER_COPY.viewBooking}.*Shares for Court 1`) });
    await expect(link).toHaveAttribute("href", `/bookings/${BOOKING}`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/bookings/${BOOKING}$`));
  });

  test("says nothing about holds when nothing is held", async ({ page }) => {
    await signIn(page);
    await serveApi(page, [
      ...memberShellRoutes({ wallet: { held_minutes: 0, spendable_minutes: 120, held_until: null } }),
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
        body: [ledgerRow("in", {}), ledgerRow("out", { subjectUserId: SAM, subjectName: PEOPLE.sam.name, signedAmountMinutes: -25, from: PEOPLE.sam.name, to: "Club treasury" })],
      },
      ...memberShellRoutes({ admin: true }),
      { path: "/api/v1/admin/members", body: [] },
      { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    ]);
    await page.goto("/admin/ledger?from=2026-09-01&to=2026-12-31");
    // The admin frame is its own lazy chunk; on a cold dev server (the first admin page of a run)
    // it compiles in more than the default 5 s.
    await expect(page.getByRole("heading", { level: 1, name: "Transactions" })).toBeVisible({ timeout: 20_000 });

    const asked = page.waitForRequest((req) => req.url().includes("/api/v1/admin/ledger") && req.url().includes("type=ShareTransfer"));
    // On a phone the filters are folded behind one button that says what they are (R4 form factor).
    const filters = page.getByRole("button", { name: /^Filters ·/ });
    if (await filters.isVisible()) await filters.click();
    await page.getByRole("combobox", { name: "Type" }).click();
    await page.getByRole("option", { name: LEDGER_TYPE_LABEL.ShareTransfer }).click();
    await expect(page).toHaveURL(/type=ShareTransfer/);
    await asked;
    // In the book itself: the phone's folded-filters button names the chosen type too (R4 form factor).
    await expect(page.getByRole("table", { name: "Club ledger" }).getByText("Share of a split booking").filter({ visible: true }).first()).toBeVisible();
    // The club's book never groups: both legs are rows, and they net to zero.
    await expect(page.getByRole("button", { name: /Shares for|Your share/ })).toHaveCount(0);
    await expect(page.locator("[data-ledger-total]").last()).toHaveText(/^0\smin/); // \s: the unit is bound with a no-break space (R8 L8-7)
  });
});
