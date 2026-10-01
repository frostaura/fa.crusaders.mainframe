import { SESSION_ADMIN, SESSION_ANON, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import type { Page } from "@playwright/test";
import { BOOK_SHEET, CANCEL_SHEET } from "../src/lib/bookingsCopy";
import { cancellationOutcome } from "../src/lib/bookingErrors";

/**
 * Item 12 where a member meets it, in an engine that has a layout.
 *
 * <p>
 * The unit suite proves each control DECLARES its intent (`components/member-confirm-intent.
 * test.tsx`). Only a browser can answer the question the founder actually asked, which is
 * whether pressing a button does anything you can see.
 * jsdom reports no geometry, runs no CSS animation, resolves no custom property and honours
 * no media query, so every assertion below is one no vitest test can make:
 * </p>
 *
 * <ul>
 *   <li>the glyph is a real stroked <code>&lt;svg&gt;</code> with non-zero size, not a
 *       character that fell back to a missing font;</li>
 *   <li>no glyph at rest — the thumbs of ruling 4 are retired by the facelift (R8/D5): a
 *       button's word is its meaning, and a mark appears only as an OUTCOME (check / alert);</li>
 *   <li>working is a spinner INSIDE the button, which keeps its width and its focus — never a
 *       frozen, disabled control (R12; the press-compression phase of the old `data-fb` theme
 *       went with the thumbs, R8/D5);</li>
 *   <li>a destructive confirm never celebrates: no tick after a cancellation;</li>
 *   <li>under <code>prefers-reduced-motion</code> the motion goes and the mark and the word
 *       stay — which is the half of a reduced-motion implementation that is
 *       usually thrown out with the animation.</li>
 * </ul>
 *
 * <p>
 * 375x812 throughout: the phone the design was measured on, and the one a member is holding in
 * the corridor outside court 3.
 * </p>
 */

const PHONE = { width: 375, height: 812 };

const COURT_A = "aaaaaaaa-0000-4000-8000-00000000000a";

function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** One court, one free slice, nothing else in the way of the dialog under test. */
function day() {
  const d = tomorrow();
  return {
    date: d, timezone: "UTC", sliceMinutes: 15,
    dayStartMinute: 7 * 60, dayEndMinute: 8 * 60,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15,
    courts: [{ id: COURT_A, courtNumber: 1, name: "Court 1" }],
    slots: [],
    rules: {
      // A window that covers the whole day. An EMPTY `allowedWindows` is not "no restriction" —
      // it is a group that may book at no time at all, and every cell draws "Not your hours".
      groups: [], allowedWindows: [{ start: "07:00", end: "08:00" }],
      clubHours: { start: "07:00", end: "08:00" },
      remainingToday: null, adminExempt: false,
    },
  };
}

/**
 * A MEMBER, not an admin: no "Book as", no quote. Since P11 a member's sheet opens on Players with
 * "Just me" chosen, and one Continue reaches the confirm (`players-book.spec.ts` walks the rest).
 * The admin's stepper and god mode have their own spec, `admin-self-booking.spec.ts`.
 */
const SESSION_MEMBER = {
  ...SESSION_ADMIN,
  is_admin: false,
};

const PROFILE = {
  full_name: "Test Member", email: "m@test.local", photo_url: null,
  membership_number: "P-1",
};

async function onPhone(page: Page) {
  await page.setViewportSize(PHONE);
}

/** Outcome marks (`data-glyph`) inside a button. At rest there are none (R8/D5). */
async function restingMarks(page: Page, name: string | RegExp) {
  return page.getByRole("button", { name }).locator("[data-glyph]").count();
}

async function openBookingSheet(page: Page) {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_MEMBER },
    { path: "/api/v1/schedule", body: day() },
    { path: "/api/v1/me/profile", body: PROFILE },
    { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { method: "POST", path: "/api/v1/bookings/", body: { booking_id: "bk-9", balance_after_minutes: 450 } },
  ]);
  await page.goto("/bookings");
  await page.getByRole("button", { name: /^Book Court 1 at / }).first().click();
  await expect(page.getByRole("dialog", { name: BOOK_SHEET.title(1) })).toBeVisible();
  await page.getByRole("button", { name: BOOK_SHEET.next }).click();
  await expect(page.getByRole("button", { name: PRIMARY })).toBeVisible();
  // The sheet ignores a Book pressed within 300 ms of the step changing (a double-tap guard).
  await page.waitForTimeout(350);
}

/** Holds the booking POST until `release` is called, so the working state can be looked at. */
async function holdBooking(page: Page) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // Registered after serveApi, so it wins for this one route.
  await page.route("**/api/v1/bookings/", async (route) => {
    await gate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ booking_id: "bk-9", balance_after_minutes: 450 }) });
  });
  return () => release();
}

const PRIMARY = BOOK_SHEET.primary(1, 15, null); // one 15-minute slice costs 15 minutes (P13 §1.1)

test.describe("the booking sheet", () => {
  test("wears no glyph at rest on the book or the way out", async ({ page }) => {
    await onPhone(page);
    await openBookingSheet(page);

    // R8/D5 retired ruling 4's thumbs: the founder called them crude. Nothing is drawn at rest;
    // a check or an alert appears only once the action has an outcome.
    expect(await restingMarks(page, PRIMARY)).toBe(0);
    expect(await restingMarks(page, BOOK_SHEET.cancel)).toBe(0);
    // And the word is the name. NN/g: a glyph without a label is ambiguous.
    await expect(page.getByRole("button", { name: PRIMARY })).toBeVisible();
  });

  test("works inside the button — a spinner, the same width, focus kept — then draws the tick", async ({ page }) => {
    await onPhone(page);
    await openBookingSheet(page);
    const release = await holdBooking(page);

    const book = page.getByRole("button", { name: PRIMARY });
    const before = (await book.boundingBox())!;
    await book.click();

    await expect(book).toHaveAttribute("aria-busy", "true");
    // Not `toBeEnabled`: Playwright reads `aria-disabled` as disabled. The point is that the
    // DOM `disabled` attribute is absent, so focus is not dropped to <body>.
    expect(await book.getAttribute("disabled")).toBeNull();
    await expect(book).toBeFocused();
    const spinner = book.locator('[data-slot="button-pending"]');
    expect(await spinner.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    const during = (await book.boundingBox())!;
    expect(Math.abs(during.width - before.width)).toBeLessThan(1);

    release();
    const dialog = page.getByRole("dialog", { name: BOOK_SHEET.title(1) });
    await expect(dialog.getByText(BOOK_SHEET.bookedTitle(1, 1))).toBeVisible();
    const check = dialog.locator('[data-glyph="check"]').first();
    const size = (await check.boundingBox())!;
    expect(size.width).toBeGreaterThan(0);
  });
});

test.describe("a destructive confirm", () => {
  /**
   * The carve-out, measured. A tick after "Cancel booking" is the software congratulating a
   * member on losing a penalty — so the danger button wears nothing at rest, and success is the
   * sheet closing with a sentence that says what moved, never a mark.
   */
  test("wears no mark, is the danger button, and never ticks", async ({ page }) => {
    await onPhone(page);
    await signIn(page);
    const d = tomorrow();
    await serveApi(page, [
      { path: "/api/v1/whoami", body: SESSION_MEMBER },
      { path: "/api/v1/me/profile", body: PROFILE },
      { path: "/api/v1/wallet", body: { balance_minutes: 500, entries: [], total_entries: 0, offset: 0, limit: 10 } },
      {
        path: "/api/v1/schedule",
        body: {
          ...day(),
          slots: [{
            courtId: COURT_A, courtNumber: 1,
            startsAtUtc: `${d}T07:00:00.000Z`, endsAtUtc: `${d}T07:15:00.000Z`,
            status: "booked", ownerUserId: SESSION_MEMBER.user_id, ownerFirstName: "Test",
            ownerPhotoUrl: null, isMine: true, bookingId: "bk-1", blockLabel: null,
            checkedIn: false, amountChargedMinutes: 50,
          }],
        },
      },
      {
        path: "/api/v1/bookings/bk-1/cancellation-quote",
        body: {
          bookingId: "bk-1", amountChargedMinutes: 50, refundMinutes: 35, penaltyMinutes: 15, penaltyPct: 30,
          penaltyWindowMinutes: 15, insidePenaltyWindow: true, checkedIn: false, alreadyStarted: false,
        },
      },
      { method: "POST", path: "/api/v1/bookings/bk-1/cancel", body: { refunded_minutes: 50, penalty_minutes: 15 } },
    ]);
    await page.goto("/bookings");
    await page.getByRole("button", { name: /^Cancel your booking on Court 1/ }).first().click();
    const dialog = page.getByRole("dialog", { name: CANCEL_SHEET.title(1) });
    await expect(dialog.getByText(CANCEL_SHEET.late(30))).toBeVisible();

    const confirm = dialog.getByRole("button", { name: CANCEL_SHEET.confirm(1) });
    // `[data-glyph]`, not any svg: the hidden working layer always holds the spinner.
    await expect(confirm.locator("[data-glyph]")).toHaveCount(0);
    expect(await restingMarks(page, CANCEL_SHEET.keep(1))).toBe(0);
    const fill = await confirm.evaluate((el) => getComputedStyle(el).backgroundColor);
    const keepFill = await dialog.getByRole("button", { name: CANCEL_SHEET.keep(1) }).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(fill).not.toBe(keepFill);

    await confirm.click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(cancellationOutcome(50, 15, null))).toBeVisible();
    await expect(page.locator('[data-glyph="check"]')).toHaveCount(0);
  });
});

test.describe("reduced motion keeps everything that is not motion", () => {
  /**
   * `prefers-reduced-motion` is a request for less MOVEMENT, not for less information — the
   * outcome mark is still drawn, finished, rather than animated in.
   */
  test("draws the success tick finished, without animating it", async ({ page }) => {
    await onPhone(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openBookingSheet(page);
    await page.getByRole("button", { name: PRIMARY }).click();
    const check = page.getByRole("dialog").locator('[data-glyph="check"]').first();
    await expect(check).toBeVisible();
    const animations = await check.evaluate((svg) =>
      [svg, ...Array.from(svg.querySelectorAll("path, circle"))].map((el) => getComputedStyle(el).animationName));
    for (const name of animations) expect(name).toBe("none");
  });
});

test.describe("the money pages a member reaches alone", () => {
  const anonRoutes: ApiRoute[] = [
    { path: "/api/v1/whoami", body: SESSION_ANON },
    { path: "/api/v1/auth/registration-policy", body: { self_registration: true, requires_approval: true } },
  ];

  test("registration's one commitment is a plain, named button at rest", async ({ page }) => {
    await onPhone(page);
    await serveApi(page, anonRoutes);
    await page.goto("/register");
    const submit = page.getByRole("button", { name: /Submit application/ });
    await expect(submit).toBeVisible();
    expect(await restingMarks(page, /Submit application/)).toBe(0);
  });

  test("top-up's continue and cancel wear no glyph at rest", async ({ page }) => {
    await onPhone(page);
    await signIn(page);
    await serveApi(page, [
      { path: "/api/v1/whoami", body: SESSION_MEMBER },
      { path: "/api/v1/me/profile", body: PROFILE },
      { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [], total_entries: 0, offset: 0, limit: 10 } },
      // The endpoint the page actually reads. This stubbed `/payments/topup-options`, which
      // nothing calls: the old page drew its form anyway on a FAILED options read, and R12's
      // top-up shows that failure (with a retry) instead of a form with no rules behind it.
      { path: "/api/v1/credit/topup/options", body: { min_zar: 50, max_zar: 5000, block_zar: 50, presets_zar: [100, 500], conversion_rate: 2 } },
    ]);
    await page.goto("/wallet/topup");

    await expect(page.getByRole("button", { name: "Continue to PayFast" })).toBeVisible();
    expect(await restingMarks(page, "Continue to PayFast")).toBe(0);
    expect(await restingMarks(page, "Cancel")).toBe(0);
  });
});
