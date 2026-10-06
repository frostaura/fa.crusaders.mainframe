import { expect, serveApi, signIn, test } from "./fixtures";
import { BOOKING, PEOPLE, SAM, detailFixture, memberShellRoutes, seat } from "./playersKit";
import { ADMIN_CANCEL } from "../src/lib/adminCancelCopy";
import { CANCEL_SHEET } from "../src/lib/bookingsCopy";

/**
 * Review round 19, lane FE19j — J19-3 in a real browser: the club's cancel sheet on a started game
 * that only a PARTNER scanned names the partner, never the organiser ("Sam has already checked in"
 * was the sheet's default). The organiser's own scan still names the organiser.
 */

test.describe.configure({ timeout: 120_000 });

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

function started(scanner: "partner" | "organiser") {
  const base = detailFixture();
  const lit = minutesAgo(22);
  return {
    ...base,
    starts_at: minutesAgo(20), ends_at: minutesAgo(-25), sold_ends_at: minutesAgo(-25),
    viewer: { role: "admin", participant_id: null },
    organiser: PEOPLE.sam,
    players: [
      seat({ user_id: SAM, name: PEOPLE.sam.name, checked_in_at: scanner === "organiser" ? lit : null }),
      seat({
        participant_id: "p0000000-0000-0000-0000-000000000012", seat: 2, kind: "member", user_id: "u-owen", name: "Owen Partner",
        status: "accepted", consented_minutes: 25, paid_minutes: 25, target_minutes: 25, checked_in_at: scanner === "partner" ? lit : minutesAgo(10),
      }),
    ],
    attendance: { checked_in_at: lit, players_checked_in: scanner === "partner" ? 1 : 2 },
    permissions: { ...(base.permissions as object), can_invite: false, can_change_split: false, can_cancel: false },
  };
}

const QUOTE = {
  bookingId: BOOKING, amountChargedMinutes: 100, refundMinutes: 0, penaltyMinutes: 0, penaltyPct: 30,
  penaltyWindowMinutes: 120, insidePenaltyWindow: false, checkedIn: true, alreadyStarted: true,
};

for (const scanner of ["partner", "organiser"] as const) {
  test(`J19-3 — the club's cancel sheet names who checked in (${scanner} scanned)`, async ({ page }) => {
    await signIn(page);
    await serveApi(page, [
      { path: `/api/v1/bookings/${BOOKING}`, body: started(scanner) },
      { path: `/api/v1/bookings/${BOOKING}/cancellation-quote`, body: QUOTE },
      ...memberShellRoutes({ admin: true }),
    ]);
    await page.goto(`/bookings/${BOOKING}`, { timeout: 90_000 });
    await page.getByRole("button", { name: ADMIN_CANCEL.open }).click();
    const sheet = page.getByRole("dialog");
    const named = scanner === "partner" ? "Owen" : "Sam";
    const other = scanner === "partner" ? "Sam" : "Owen";
    await expect(sheet.getByText(CANCEL_SHEET.checkedIn(named))).toBeVisible();
    await expect(sheet.getByText(CANCEL_SHEET.checkedIn(other))).toHaveCount(0);
  });
}
