import { SESSION_ADMIN, SESSION_ANON, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import type { Page } from "@playwright/test";

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
 *   <li>pressing moves the button, and pressing a destructive one does not;</li>
 *   <li>under <code>prefers-reduced-motion</code> the motion goes and the colour and the word
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
    courts: [{ id: COURT_A, courtNumber: 1, name: "Court 1", slicePriceCredits: 50 }],
    slots: [],
    rules: {
      // A window that covers the whole day. An EMPTY `allowedWindows` is not "no restriction" —
      // it is a group that may book at no time at all, and every cell draws "Not your hours".
      groups: [], allowedWindows: [{ start: "07:00", end: "08:00" }],
      clubHours: { start: "07:00", end: "08:00" },
      slicePriceCredits: 50, remainingToday: null, adminExempt: false,
    },
  };
}

/**
 * A MEMBER, not an admin — and it is load-bearing rather than tidy.
 *
 * <p>
 * `SESSION_ADMIN` opens the booking dialog on "on behalf of a member" with nobody chosen, so
 * its confirm is `disabled`; `index.css`'s `button:disabled { transform: none }` is (0,1,1)
 * and beats the `scale-[0.97]` utility's (0,1,0), so the press compression genuinely does not
 * render — correctly, on a button that cannot be pressed. Walking item 12 through that session
 * measures a disabled control and reports it as a missing theme. These screens are the
 * member's; the walk is the member's.
 * </p>
 */
const SESSION_MEMBER = {
  ...SESSION_ADMIN,
  is_admin: false,
};

const PROFILE = {
  full_name: "Test Member", email: "m@test.local", photo_url: null,
  membership_number: "P-1", member_class: "Regular",
};

async function onPhone(page: Page) {
  await page.setViewportSize(PHONE);
}

/**
 * What a press looks like, sampled while it is happening.
 *
 * <p>
 * <b>Both obvious ways of asking this return "nothing happened", for different reasons.</b>
 * Reading `getComputedStyle` at the instant the class lands gives the value the transition is
 * moving AWAY from — `none` — because the transition has not produced a frame yet. Waiting for
 * it to finish and then reading gives `none` as well, because the press RELEASES ITSELF after
 * `duration.press` whether or not a pointerup ever arrives (`useActionFeedback` records why:
 * arming a `ConfirmButton` unmounts the trigger under the finger). The window in which a press
 * is visible is 90 ms wide and both reads sit outside it.
 * </p>
 *
 * <p>
 * So the press is dispatched and sampled inside ONE page-side task: no protocol round trip can
 * land in the middle of the window, and what comes back is every frame of it rather than one
 * guessed instant.
 * </p>
 */
async function samplePress(page: Page, name: string | RegExp) {
  return page.getByRole("button", { name }).evaluate(async (el: Element) => {
    const frames: { fb: string | null; transform: string; animation: string }[] = [];
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    // Every ~8 ms across the 90 ms compression, plus a little past it.
    for (let i = 0; i < 14; i++) {
      await new Promise(requestAnimationFrame);
      const style = getComputedStyle(el);
      frames.push({
        fb: el.getAttribute("data-fb"),
        transform: style.transform,
        animation: style.animationName,
      });
    }
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    return frames;
  });
}

/** A transform that actually shrinks the button, as opposed to `none` or the identity. */
function compressed(transform: string): boolean {
  const m = /matrix\(([^)]+)\)/.exec(transform);
  if (!m) return false;
  const [a, , , d] = m[1].split(",").map((n) => Number.parseFloat(n));
  return a < 0.999 && d < 0.999;
}

/** Outcome marks (`data-glyph`) inside a button. At rest there are none (R8/D5). */
async function restingMarks(page: Page, name: string | RegExp) {
  return page.getByRole("button", { name }).locator("[data-glyph]").count();
}

async function openBookingDialog(page: Page) {
  await signIn(page);
  await serveApi(page, [
    { path: "/api/v1/whoami", body: SESSION_MEMBER },
    { path: "/api/v1/schedule", body: day() },
    { path: "/api/v1/admin/members/", body: [] },
    { path: "/api/v1/me/profile", body: PROFILE },
    { path: "/api/v1/wallet", body: { balance_credits: 500, entries: [], total_entries: 0, offset: 0, limit: 10 } },
  ]);
  await page.goto("/schedule");
  await page.waitForSelector('[role="grid"]');
  await page.getByRole("gridcell").locator("button", { hasText: "Available" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test.describe("the booking dialog", () => {
  test("wears no glyph at rest on the yes or the way out", async ({ page }) => {
    await onPhone(page);
    await openBookingDialog(page);

    // R8/D5 retired ruling 4's thumbs: the founder called them crude. Nothing is drawn at rest;
    // a check or an alert appears only once the action has an outcome.
    expect(await restingMarks(page, /Book for/)).toBe(0);
    const wayOut = page.getByRole("dialog").getByRole("button").filter({ hasNotText: /Book for/ }).first();
    expect(await wayOut.locator("[data-glyph]").count()).toBe(0);

    // And the word is the name. NN/g: a glyph without a label is ambiguous, and this
    // audience is the one that pays for ambiguity.
    await expect(page.getByRole("button", { name: /Book for 50\.00/ })).toBeVisible();
  });

  test("moves under a press, and says it is working", async ({ page }) => {
    await onPhone(page);
    await openBookingDialog(page);

    const confirm = page.getByRole("button", { name: /Book for/ });
    expect(await confirm.evaluate((el) => getComputedStyle(el).transform)).toBe("none");

    const frames = await samplePress(page, /Book for/);

    // The phase is reached, and it ends by itself — 90 ms of compression, not a button left
    // squashed until a pointerup that may never arrive.
    expect(frames.some((f) => f.fb === "press")).toBe(true);
    expect(frames[frames.length - 1].fb).toBe("rest");

    // The compression is what makes a tap feel LANDED on a phone, and it is the assertion a
    // class-name check cannot make: `scale-[0.97]` means nothing until something computes it.
    expect(frames.some((f) => compressed(f.transform))).toBe(true);
  });
});

test.describe("a destructive confirm", () => {
  /**
   * The carve-out, measured. Ruling 4 in one sentence: a thumbs-up on "Cancel the booking" is
   * the software claiming it approves of a member losing a 15.00 penalty.
   */
  test("wears no mark and does not snap", async ({ page }) => {
    await onPhone(page);
    await signIn(page);
    const d = tomorrow();
    await serveApi(page, [
      { path: "/api/v1/whoami", body: SESSION_MEMBER },
      { path: "/api/v1/me/profile", body: PROFILE },
      { path: "/api/v1/wallet", body: { balance_credits: 500, entries: [], total_entries: 0, offset: 0, limit: 10 } },
      { path: "/api/v1/admin/members/", body: [] },
      {
        path: "/api/v1/schedule",
        body: {
          ...day(),
          slots: [{
            courtId: COURT_A, courtNumber: 1,
            startsAtUtc: `${d}T07:00:00.000Z`, endsAtUtc: `${d}T07:15:00.000Z`,
            status: "booked", ownerUserId: SESSION_MEMBER.user_id, ownerFirstName: "Test",
            ownerPhotoUrl: null, isMine: true, bookingId: "bk-1", blockLabel: null,
            checkedIn: false, amountChargedCredits: 50,
          }],
        },
      },
      {
        path: "/api/v1/bookings/bk-1/cancellation-quote",
        body: { refundCredits: 35, penaltyCredits: 15, checkedIn: false },
      },
    ]);
    await page.goto("/schedule");
    await page.waitForSelector('[role="grid"]');
    await page.getByRole("gridcell").locator("button", { hasText: "Mine" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();

    const confirm = page.getByRole("button", { name: "Cancel the booking" });
    await expect(confirm).toHaveAttribute("data-intent", "destructive");
    // No glyph at all — not a different one. `glyphKindFor` returns null for destructive at
    // every phase but failure, which is the whole of the carve-out.
    // (`[data-glyph]`, not any svg: the hidden working layer always holds the spinner.)
    await expect(confirm.locator("[data-glyph]")).toHaveCount(0);

    // The way out wears nothing at rest either (R8/D5).
    expect(await restingMarks(page, "Keep the booking")).toBe(0);

    const frames = await samplePress(page, "Cancel the booking");
    expect(frames.some((f) => f.fb === "press")).toBe(true);
    // It settles rather than snapping: not one frame of the whole press window shrinks it. A
    // button that shuts a door should not feel eager.
    expect(frames.some((f) => compressed(f.transform))).toBe(false);
  });
});

test.describe("reduced motion keeps everything that is not motion", () => {
  /**
   * The half that usually gets thrown out with the animation. `prefers-reduced-motion` is a
   * request for less MOVEMENT, not for less information — a member who has asked for it still
   * needs to know which button is the yes.
   */
  test("drops the transform and keeps the colour and the word", async ({ page }) => {
    await onPhone(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openBookingDialog(page);

    const frames = await samplePress(page, /Book for/);

    // The phase still HAPPENS — it is what the outcome hangs off — and it is simply not drawn
    // as movement. `index.css` stands `[data-fb]` down to `transform: none !important`.
    expect(frames.some((f) => f.fb === "press")).toBe(true);
    for (const f of frames) {
      expect(f.transform).toBe("none");
      expect(f.animation).toBe("none");
    }
    await expect(page.getByRole("button", { name: /Book for 50\.00/ })).toBeVisible();
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
      { path: "/api/v1/wallet", body: { balance_credits: 0, entries: [], total_entries: 0, offset: 0, limit: 10 } },
      { path: "/api/v1/payments/topup-options", body: { min_zar: 50, max_zar: 5000, step_zar: 50, presets: [100, 500], credits_per_rand: 2 } },
    ]);
    await page.goto("/wallet/topup");

    await expect(page.getByRole("button", { name: "Continue to PayFast" })).toBeVisible();
    expect(await restingMarks(page, "Continue to PayFast")).toBe(0);
    expect(await restingMarks(page, "Cancel")).toBe(0);
  });
});
