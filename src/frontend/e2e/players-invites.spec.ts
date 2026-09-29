import type { Page, Route } from "@playwright/test";
import { expect, serveApi, signIn, test, type ApiRoute } from "./fixtures";
import { BOOKING, COURT, PEOPLE, inviteFixture, memberShellRoutes } from "./playersKit";
import { INVITES_COPY } from "../src/lib/playersCopy";

/**
 * P11 — invites in a real browser, on a phone and a desktop: the Bookings badge into Invites and
 * an accept to its confirmation; a share raised between the sheet and the tap (shown, re-read,
 * asked again — never retried by itself); a shared link accepted; a bad link answered in words.
 */

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const SEAT = "p0000000-0000-0000-0000-000000000003";
const ACCEPT = `/api/v1/bookings/${BOOKING}/players/${SEAT}/accept`;

/** Sam's invite to the member — the kit's invite with a different organiser than the viewer. */
function samInvite(overrides: Record<string, unknown> = {}) {
  return inviteFixture({ organiser: PEOPLE.sam, ...overrides });
}

function tomorrowDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** A quiet day on one court, enough for the Bookings page to draw. */
function scheduleDay() {
  return {
    date: tomorrowDate(), timezone: "Africa/Johannesburg", sliceMinutes: 15,
    dayStartMinute: 7 * 60, dayEndMinute: 9 * 60, advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15,
    courts: [{ id: COURT, courtNumber: 1, name: "Court 1", slicePriceCredits: 25 }],
    slots: [],
    rules: { clubHours: { start: "07:00", end: "09:00" }, remainingToday: null, adminExempt: false },
  };
}

async function open(page: Page, routes: ApiRoute[], invites: unknown[] = [samInvite()]) {
  await signIn(page);
  await serveApi(page, [...routes, ...memberShellRoutes({ invites }), { path: "/api/v1/schedule", body: scheduleDay() }]);
}

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

const accepted = (share: number) => ({
  participant_id: SEAT, booking_id: BOOKING, status: "accepted", share_credits: share, consented_credits: share, paid_credits: share, balance_credits: 120 - share,
});

test("the Bookings badge leads to Invites, and an accept ends in a calm confirmation", async ({ page }) => {
  const sent: unknown[] = [];
  await open(page, [{ method: "POST", path: ACCEPT, respond: ({ body }) => { sent.push(body); return accepted(25); } }]);
  await page.goto(`/bookings?date=${tomorrowDate()}`);

  await page.getByRole("link", { name: "1 invite waiting" }).click();
  await expect(page).toHaveURL(/\/bookings\/invites$/);
  await expect(page.getByRole("heading", { level: 1, name: "Invites" })).toBeVisible();

  await page.getByRole("button", { name: /Sam invited you to play/ }).click();
  const sheet = page.getByRole("dialog", { name: "Join this game?" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Balance after")).toBeVisible();
  await sheet.getByRole("button", { name: "Accept and pay 25.00 cr" }).click();

  await expect(sheet.getByText("You're in", { exact: true })).toBeVisible();
  await expect(sheet.getByRole("link", { name: "See the booking" })).toHaveAttribute("href", `/bookings/${BOOKING}`);
  expect(sent).toEqual([{ expectedShareCredits: 25 }]);
});

test("a share raised after the sheet opened is shown and asked again", async ({ page }) => {
  let raised = false;
  const sent: unknown[] = [];
  await open(page, []);
  await page.route("**/api/v1/me/invites", (route) => json(route, 200, {
    items: [raised ? samInvite({ share_credits: 30, to_pay_credits: 30 }) : samInvite()], count: 1,
  }));
  await page.route(`**${ACCEPT}`, async (route) => {
    const body = route.request().postDataJSON() as { expectedShareCredits: number };
    sent.push(body);
    raised = true;
    if (body.expectedShareCredits < 30) await json(route, 409, { error: "share_changed", share_credits: 30 });
    else await json(route, 200, accepted(30));
  });
  await page.goto("/bookings/invites");

  await page.getByRole("button", { name: /Sam invited you to play/ }).click();
  const sheet = page.getByRole("dialog", { name: "Join this game?" });
  await sheet.getByRole("button", { name: "Accept and pay 25.00 cr" }).click();
  await expect(sheet.getByText("Your share is now 30.00 cr. Check it and say yes again if you're happy.")).toBeVisible();
  const again = sheet.getByRole("button", { name: "Accept and pay 30.00 cr" });
  await expect(again).toBeVisible();
  expect(sent).toHaveLength(1);

  await again.click();
  await expect(sheet.getByText("You're in", { exact: true })).toBeVisible();
  expect(sent).toEqual([{ expectedShareCredits: 25 }, { expectedShareCredits: 30 }]);
});

test("a shared link opens as a page and accepts through the link", async ({ page }) => {
  const sent: unknown[] = [];
  await open(page, [
    { path: `/api/v1/invites/${TOKEN}`, body: samInvite({ open_link: true, participant_id: "p4" }) },
    { method: "POST", path: `/api/v1/invites/${TOKEN}/accept`, respond: ({ body }) => { sent.push(body); return accepted(25); } },
  ]);
  await page.goto(`/j/${TOKEN}`);

  await expect(page.getByRole("heading", { level: 1, name: "You're invited" })).toBeVisible();
  await expect(page.getByText("Sam invited you to take a seat")).toBeVisible();
  await expect(page.getByRole("button", { name: "Decline" })).toHaveCount(0);
  await page.getByRole("button", { name: "Accept and pay 25.00 cr" }).click();
  await expect(page.getByText("You're in", { exact: true })).toBeVisible();
  expect(sent).toEqual([{ expectedShareCredits: 25 }]);
});

test("a link that names nothing is answered in a sentence, with a way back", async ({ page }) => {
  await open(page, [{ path: "/api/v1/invites/not-a-token", status: 404, body: { error: "invite_not_found" } }]);
  await page.goto("/j/not-a-token");

  await expect(page.getByText(INVITES_COPY.linkNotFound)).toBeVisible();
  // D5 — it may be another member's: the way to open it as them.
  await expect(page.getByRole("button", { name: INVITES_COPY.signOutToOpen })).toBeVisible();
  await expect(page.getByRole("link", { name: "See your invites" })).toHaveAttribute("href", "/bookings/invites");
  await expect(page.getByRole("button", { name: /Accept/ })).toHaveCount(0);
});
