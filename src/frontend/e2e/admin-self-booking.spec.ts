import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { BOOK_SHEET, GOD_MODE } from "../src/lib/bookingsCopy";

/**
 * R19 — admin god mode, in a real browser: an admin books themselves or a member even at or below
 * zero, is TOLD where it leaves the payer before pressing anything, and the booking goes out once
 * with `allowNegativeBalance` sent on purpose.
 *
 * <p>
 * <b>What this replaced.</b> The old dialog learned about a short wallet by being refused: POST,
 * read the 402, offer "Book anyway — leaves −40 min", POST again — and refused the override
 * outright for an admin's own wallet, which sent the desk round a loop with no exit (the defect
 * this file was first written about). R19 made self-overdraft legal and moved the figures in
 * front of the button: the sheet asks `GET /admin/bookings/quote` first. The 402 routes are gone
 * from these stubs on purpose — a sheet that still fell back to the dance would hit an unstubbed
 * route and fail loudly.
 * </p>
 *
 * <p>
 * Browser, not vitest, because the defect class is a sequence of screen states (quote → notice →
 * one POST) across a real render loop and a real bottom sheet on the phone project.
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
  courts: [{ id: COURT, courtNumber: 1, name: "Court 1" }],
  slots: [],
});

function quote(userId: string, balance: number) {
  return {
    user_id: userId, court_id: COURT, court_name: "Court 1", starts_at: `${tomorrow()}T07:00:00Z`, ends_at: null,
    slices: 1, price_minutes: 50, balance_minutes: balance, balance_after_minutes: balance - 50, overdraws: balance < 50,
  };
}

function routes(extra: ApiRoute[]): ApiRoute[] {
  return [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/wallet", body: { balance_minutes: 10, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@test.local", photo_url: null, membership_number: "A-1" } },
    { path: "/api/v1/admin/members", body: [
      { user_id: ADMIN_ID, full_name: "Crusaders Admin", photo_url: null, balance_minutes: 10 },
      { user_id: MEMBER_ID, full_name: "Naledi Khumalo", photo_url: null, balance_minutes: 34 },
    ] },
    { path: "/api/v1/schedule", body: day() },
    ...extra,
  ];
}

/**
 * The sheet ignores a press on its confirm for 300 ms after a step change, so the second half of
 * a double tap on Continue cannot land on the Book button that replaces it. A person reads the
 * notice for longer than that; a test has to wait it out on purpose.
 */
async function pastTheStepGuard(page: import("@playwright/test").Page) {
  await page.waitForTimeout(350);
}

async function openFirstFreeSlot(page: import("@playwright/test").Page) {
  await page.goto("/bookings");
  // P13 §3.12 — a free cell's name carries no price.
  await page.getByRole("button", { name: /^Book Court 1 at / }).first().click();
  const sheet = page.getByRole("dialog", { name: BOOK_SHEET.title(1) });
  await expect(sheet).toBeVisible();
  return sheet;
}

test("an admin books their own court below zero — told first, sent once, with the flag", async ({ page }) => {
  await signIn(page);
  const posts: unknown[] = [];
  await serveApi(page, routes([
    { path: "/api/v1/admin/bookings/quote", body: quote(ADMIN_ID, 10) },
    {
      method: "POST", path: "/api/v1/admin/bookings",
      respond: ({ body }) => { posts.push(body); return { booking_id: "bk-1", balance_after_minutes: -40 }; },
    },
  ]));

  const sheet = await openFirstFreeSlot(page);
  await expect(sheet.getByRole("radio", { name: BOOK_SHEET.asSelf })).toHaveAttribute("aria-checked", "true");
  await sheet.getByRole("button", { name: BOOK_SHEET.next }).click();
  // Booking as themselves, the admin passes the member's Players step ("Just me") on the way.
  await sheet.getByRole("button", { name: BOOK_SHEET.next }).click();

  await expect(sheet.getByText(GOD_MODE.body(null, -40))).toBeVisible();
  await pastTheStepGuard(page);
  await sheet.getByRole("button", { name: BOOK_SHEET.primary(1, 50, null) }).click();
  await expect(sheet.getByText(BOOK_SHEET.bookedTitle(1, 1))).toBeVisible();

  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ userId: ADMIN_ID, allowNegativeBalance: true });
});

test("an admin books a member below zero — the member is named and the notice says by how much", async ({ page }) => {
  await signIn(page);
  const posts: unknown[] = [];
  await serveApi(page, routes([
    { path: "/api/v1/admin/bookings/quote", body: quote(MEMBER_ID, 34) },
    {
      method: "POST", path: "/api/v1/admin/bookings",
      respond: ({ body }) => { posts.push(body); return { booking_id: "bk-2", balance_after_minutes: -16 }; },
    },
  ]));

  const sheet = await openFirstFreeSlot(page);
  await sheet.getByRole("radio", { name: BOOK_SHEET.asMember }).click();
  await sheet.getByRole("combobox", { name: new RegExp(`^${BOOK_SHEET.memberLabel}`) }).click();
  await page.getByRole("option", { name: /Naledi Khumalo/ }).click();
  await sheet.getByRole("button", { name: BOOK_SHEET.next }).click();

  await expect(sheet.getByText(GOD_MODE.body("Naledi Khumalo", -16))).toBeVisible();
  await pastTheStepGuard(page);
  await sheet.getByRole("button", { name: BOOK_SHEET.primary(1, 50, "Naledi") }).click();
  await expect(sheet.getByText(BOOK_SHEET.balanceLine(-16, "Naledi Khumalo"))).toBeVisible();

  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ userId: MEMBER_ID, allowNegativeBalance: true });
});

test("no notice and no flag when the quote says the payer can cover it", async ({ page }) => {
  await signIn(page);
  const posts: unknown[] = [];
  await serveApi(page, routes([
    { path: "/api/v1/admin/bookings/quote", body: quote(ADMIN_ID, 500) },
    {
      method: "POST", path: "/api/v1/admin/bookings",
      respond: ({ body }) => { posts.push(body); return { booking_id: "bk-3", balance_after_minutes: 450 }; },
    },
  ]));

  const sheet = await openFirstFreeSlot(page);
  await sheet.getByRole("button", { name: BOOK_SHEET.next }).click();
  await sheet.getByRole("button", { name: BOOK_SHEET.next }).click();
  const book = sheet.getByRole("button", { name: BOOK_SHEET.primary(1, 50, null) });
  await expect(book).toBeVisible();
  await expect(sheet.getByText(GOD_MODE.title)).toHaveCount(0);
  await pastTheStepGuard(page);
  await book.click();
  await expect(sheet.getByText(BOOK_SHEET.bookedTitle(1, 1))).toBeVisible();
  expect(posts[0]).toMatchObject({ allowNegativeBalance: false });
});
