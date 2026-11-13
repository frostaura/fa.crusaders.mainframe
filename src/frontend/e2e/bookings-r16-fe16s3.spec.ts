import { expect, serveApi, signIn, test, type ApiRoute, singleTap } from "./fixtures";
import { BOOKING, PEOPLE, SAM, detailFixture, memberShellRoutes, seat } from "./playersKit";
import { ADMIN_CANCEL } from "../src/lib/adminCancelCopy";
import { BOOK_SHEET, CANCEL_SHEET } from "../src/lib/bookingsCopy";
import { DETAIL_ADMIN } from "../src/lib/playersCopy";

/**
 * Review round 16, lane FE16s3 — the desk's two sheets, in a real browser.
 *
 * <ul>
 *   <li><b>J16-7</b> — the club cancelling a started, checked-in split session: the sheet said
 *   "Paid · Back to Sam 0" and nothing of the partners, whose shares STAND. It now says whose and
 *   how much, staying with the organiser (one partner and two).</li>
 *   <li><b>J16-3</b> — the desk's "Book as" combobox: two members called "Pia van Partner" read
 *   alike. Each row carries the membership number and email; the one picked is the one booked.</li>
 * </ul>
 */

test.describe.configure({ timeout: 120_000 });

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

function startedSplit(partners: { id: string; name: string; paid: number }[]) {
  const base = detailFixture();
  // R19 J19-3 — Sam's own scan lit the court: his seat is stamped at the booking's instant, which is
  // how the sheet knows to name him (a partner's lone scan names the partner).
  const lit = minutesAgo(22);
  return {
    ...base,
    starts_at: minutesAgo(20), ends_at: minutesAgo(-25), sold_ends_at: minutesAgo(-25),
    viewer: { role: "admin", participant_id: null },
    organiser: PEOPLE.sam,
    players: [
      seat({ user_id: SAM, name: PEOPLE.sam.name, checked_in_at: lit }),
      ...partners.map((p, i) => seat({
        participant_id: `p0000000-0000-0000-0000-00000000001${i}`, seat: i + 2, kind: "member", user_id: p.id, name: p.name,
        status: "accepted", consented_minutes: p.paid, paid_minutes: p.paid, target_minutes: p.paid,
      })),
    ],
    attendance: { checked_in_at: lit, players_checked_in: 1 },
    permissions: { ...(base.permissions as object), can_invite: false, can_change_split: false, can_cancel: false },
  };
}

const QUOTE = {
  bookingId: BOOKING, amountChargedMinutes: 100, refundMinutes: 0, penaltyMinutes: 0, penaltyPct: 30,
  penaltyWindowMinutes: 120, insidePenaltyWindow: false, checkedIn: true, alreadyStarted: true,
};

const CASES = [
  { label: "one partner", partners: [{ id: "u-owen", name: "Owen Partner", paid: 25 }], shares: ["Owen's 25 minutes"] },
  {
    label: "two partners",
    partners: [{ id: "u-owen", name: "Owen Partner", paid: 25 }, { id: "u-pia", name: "Pia Partner", paid: 10 }],
    shares: ["Owen's 25 minutes", "Pia's 10 minutes"],
  },
];

for (const c of CASES) {
  test(`J16-7 — the club's cancel sheet on a started split says the shares stand (${c.label})`, async ({ page }) => {
    await signIn(page);
    await serveApi(page, [
      { path: `/api/v1/bookings/${BOOKING}`, body: startedSplit(c.partners) },
      { path: `/api/v1/bookings/${BOOKING}/cancellation-quote`, body: QUOTE },
      ...memberShellRoutes({ admin: true }),
    ]);
    await page.goto(`/bookings/${BOOKING}`, { timeout: 90_000 });
    await page.getByRole("button", { name: ADMIN_CANCEL.open }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText(CANCEL_SHEET.checkedIn("Sam"))).toBeVisible();
    await expect(sheet.getByText(ADMIN_CANCEL.sharesStand(c.shares, "Sam"))).toBeVisible();
  });
}

/* ─────────────────────────────── J16-3 ─────────────────────────────── */

const COURT = "aaaaaaaa-0000-4000-8000-00000000000c";
const ADMIN_ID = "00000000-0000-0000-0000-000000000002";
const PIA_A = "bbbbbbbb-0000-4000-8000-00000000000a";
const PIA_B = "bbbbbbbb-0000-4000-8000-00000000000b";

function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const member = (id: string, number: string, email: string) => ({
  membership_id: `m-${id}`, user_id: id, email, full_name: "Pia van Partner", membership_number: number, photo_url: null,
  status: "Active", created_at: "2024-01-01T00:00:00Z", rejection_reason: null, balance_minutes: 200,
});

function bookRoutes(quoted: string[], posts: unknown[]): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: { tenant_slug: "crusaders", tenant_id: "00000000-0000-0000-0000-000000000001", user_id: ADMIN_ID, is_authenticated: true, is_admin: true } },
    { path: "/api/v1/wallet", body: { balance_minutes: 10, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@club.review.test", photo_url: null, membership_number: "A-1" } },
    { path: "/api/v1/admin/members", body: [member(PIA_A, "1042", "pia@club.review.test"), member(PIA_B, "2210", "pia.vp@club.review.test")] },
    { path: "/api/v1/schedule", body: {
      date: tomorrow(), timezone: "UTC", sliceMinutes: 15, dayStartMinute: 7 * 60, dayEndMinute: 20 * 60, advanceBookingDays: 14,
      penaltyPct: 30, penaltyWindowMinutes: 15, courts: [{ id: COURT, courtNumber: 1, name: "Court 1" }], slots: [],
    } },
    {
      path: "/api/v1/admin/bookings/quote",
      respond: ({ path }) => {
        quoted.push(path);
        return { user_id: PIA_B, court_id: COURT, court_name: "Court 1", starts_at: `${tomorrow()}T07:00:00Z`, ends_at: null, slices: 1, price_minutes: 50, balance_minutes: 200, balance_after_minutes: 150, overdraws: false };
      },
    },
    { method: "POST", path: "/api/v1/admin/bookings", respond: ({ body }) => { posts.push(body); return { booking_id: "bk-pia", balance_after_minutes: 150 }; } },
  ];
}

test("J16-3 — the desk tells two Pia van Partners apart and books the one it picked", async ({ page }) => {
  await signIn(page);
  const quoted: string[] = [];
  const posts: unknown[] = [];
  await serveApi(page, bookRoutes(quoted, posts));
  await page.goto("/bookings", { timeout: 90_000 });
  await singleTap(page);
  await page.getByRole("button", { name: /^Book Court 1 at / }).first().click();
  const sheet = page.getByRole("dialog", { name: BOOK_SHEET.title(1) });
  await sheet.getByRole("radio", { name: BOOK_SHEET.asMember }).click();
  await sheet.getByRole("combobox", { name: new RegExp(`^${BOOK_SHEET.memberLabel}`) }).click();

  const a = page.getByRole("option").filter({ hasText: DETAIL_ADMIN.memberSubtitle("1042", "pia@club.review.test") });
  const b = page.getByRole("option").filter({ hasText: DETAIL_ADMIN.memberSubtitle("2210", "pia.vp@club.review.test") });
  await expect(a).toBeVisible();
  await expect(b).toBeVisible();
  await expect(page.getByRole("option", { name: /Pia van Partner/ })).toHaveCount(2);
  await b.click();

  await expect(sheet.getByRole("combobox", { name: new RegExp(`^${BOOK_SHEET.memberLabel}`) })).toContainText("#2210 · pia.vp@club.review.test");
  await sheet.getByRole("button", { name: BOOK_SHEET.next }).click();
  await page.waitForTimeout(350); // the sheet's own double-tap guard after a step change
  await sheet.getByRole("button", { name: BOOK_SHEET.primary(1, 50, "Pia") }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ userId: PIA_B });
});
