import type { Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { BOOK_SHEET, BOOKINGS_COPY, selectionCapShort } from "../src/lib/bookingsCopy";

/**
 * Review round 4 on the Bookings screen, where only a browser can tell (lane F1): a booking in
 * flight keeps its sheet (I4-1), a quick first tap books and a double tap's tail does not (I4-2),
 * a pick past the daily cap is said on screen (M4-7), and the Jump-to-a-date calendar fits a
 * 320px phone and a 390px phone at 200% text (X4-3).
 */

const COURTS = ["a", "b"].map((x, i) => ({
  id: `aaaaaaaa-0000-4000-8000-00000000000${x}`, courtNumber: i + 1, name: `Court ${i + 1}`, slicePriceCredits: 50,
}));

const inDays = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DAY = inDays(2);

function wholeDay(slots: unknown[] = [], rules?: unknown) {
  return {
    date: DAY, timezone: "UTC", sliceMinutes: 15, dayStartMinute: 8 * 60, dayEndMinute: 20 * 60,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: COURTS, slots, ...(rules ? { rules } : {}),
  };
}

async function open(page: Page, routes: ApiRoute[] = [], bigText = false) {
  await signIn(page);
  await serveApi(page, [
    ...routes,
    { path: "/api/v1/whoami", body: { ...SESSION_ADMIN, is_admin: false } },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: "UTC", items: [] } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: "UTC", items: [] } },
    { path: "/api/v1/wallet", body: { balance_credits: 500, entries: [], total_entries: 0, offset: 0, limit: 10 } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", body: { ticket: "t", expires_in_seconds: 60 } },
  ].filter((r, i, all) => all.findIndex((o) => o.path === r.path && (o.method ?? "GET") === (r.method ?? "GET")) === i));
  await page.goto(`/bookings?date=${DAY}`);
  if (bigText) await page.addStyleTag({ content: "html { font-size: 32px; }" });
  await page.waitForSelector('[role="grid"]');
}

/** Holds every booking POST until the test lets it go — the slow club. */
async function holdBookings(page: Page) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let posts = 0;
  await page.route("**/api/v1/bookings/", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts += 1;
    await gate;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ booking_id: "bbbbbbbb-0000-4000-8000-000000000001", balance_after_credits: 450 }) });
  });
  return { release: () => release(), posts: () => posts };
}

const bookCell = (page: Page, time: string) => page.getByRole("button", { name: new RegExp(`^Book Court 1 at ${time}`) });

test.describe("I4-1 — a booking in flight keeps its sheet", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Back, Escape, the × and the system Back all wait for the club, then the outcome is shown", async ({ page }) => {
    await open(page, [{ path: "/api/v1/schedule", body: wholeDay() }]);
    const slow = await holdBookings(page);
    await bookCell(page, "10:00").click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: BOOK_SHEET.next }).click();
    await sheet.getByRole("button", { name: /^Book · / }).click();
    await expect(sheet.getByText(BOOK_SHEET.sending)).toBeVisible();

    await sheet.getByRole("button", { name: BOOK_SHEET.back }).click({ force: true });
    await page.keyboard.press("Escape");
    await sheet.getByRole("button", { name: /^Close/ }).click();
    await page.goBack();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: /^Book · / })).toHaveAttribute("aria-busy", "true");
    expect(page.url()).toContain("/bookings");

    slow.release();
    await expect(sheet.getByText("Court booked")).toBeVisible();
    expect(slow.posts()).toBe(1);
    await sheet.getByRole("button", { name: BOOK_SHEET.done }).click();
    await expect(sheet).toBeHidden();
  });
});

test.describe("I4-2 — a double tap's tail is ignored, a quick first tap books", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("double-clicking Continue sends nothing and says why; a click straight after books", async ({ page }) => {
    await open(page, [{ path: "/api/v1/schedule", body: wholeDay() }]);
    let posts = 0;
    await page.route("**/api/v1/bookings/", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posts += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ booking_id: "bbbbbbbb-0000-4000-8000-000000000001", balance_after_credits: 450 }) });
    });
    await bookCell(page, "10:00").click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: BOOK_SHEET.next }).dblclick();
    await expect(sheet.getByText(BOOK_SHEET.doubleTapIgnored)).toBeVisible();
    expect(posts).toBe(0);
    await sheet.getByRole("button", { name: BOOK_SHEET.back }).click();
    await sheet.getByRole("button", { name: BOOK_SHEET.next }).click();
    await sheet.getByRole("button", { name: /^Book · / }).click();
    await expect(sheet.getByText("Court booked")).toBeVisible();
    expect(posts).toBe(1);
  });
});

test.describe("M4-7 — a pick past the daily cap is said on screen", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the selection bar names the limit when a pick is refused", async ({ page }) => {
    const rules = { maxSlotsPerDay: 2, bookedSlotsToday: 0, remainingToday: 2, adminExempt: false };
    await open(page, [{ path: "/api/v1/schedule", body: wholeDay([], rules) }]);
    await page.getByRole("button", { name: BOOKINGS_COPY.selectOn }).click();
    for (const t of ["10:00", "10:15", "10:30"]) await page.getByRole("button", { name: new RegExp(`Court 1 at ${t}`) }).click();
    const bar = page.getByRole("toolbar", { name: BOOKINGS_COPY.actionBarLabel });
    // The shown day is not today, so the sentence names it: "Limit reached: 2 slots on Fri 2 Oct."
    await expect(bar.locator("[data-cap-refusal]")).toHaveText(/^Limit reached: 2 slots on \w{3} \d{1,2} \w{3}\.$/);
    await expect(bar.locator("[data-cap-refusal]")).toBeVisible();
    expect(selectionCapShort(2)).toBe("Limit reached: 2 slots today.");
  });
});

test.describe("X4-3 — Jump to a date fits the phone", () => {
  for (const { width, height, bigText } of [
    { width: 320, height: 640, bigText: false },
    { width: 390, height: 844, bigText: true },
    { width: 320, height: 640, bigText: true },
  ]) {
    test(`every day and both month arrows are on screen at ${width}${bigText ? " / 200%" : ""}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page, [{ path: "/api/v1/schedule", body: wholeDay() }], bigText);
      await page.getByRole("button", { name: /Jump to a date/ }).click();
      await page.waitForSelector("[data-slot=calendar-day]");
      const fit = await page.evaluate(() => {
        const rights = [...document.querySelectorAll("[data-slot=calendar] button")].map((b) => b.getBoundingClientRect().right);
        const lefts = [...document.querySelectorAll("[data-slot=calendar] button")].map((b) => b.getBoundingClientRect().left);
        const dialog = document.querySelector("[role=dialog]")!;
        return { right: Math.max(...rights), left: Math.min(...lefts), vw: innerWidth, sideways: dialog.scrollWidth - dialog.clientWidth };
      });
      expect(fit.right, JSON.stringify(fit)).toBeLessThanOrEqual(fit.vw);
      expect(fit.left).toBeGreaterThanOrEqual(0);
      expect(fit.sideways).toBe(0);
    });
  }
});
