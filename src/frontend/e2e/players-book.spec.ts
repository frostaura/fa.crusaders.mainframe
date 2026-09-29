import type { Page } from "@playwright/test";
import { serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { PEOPLE, SAM, memberShellRoutes } from "./playersKit";
import { BOOK_SEATS, BOOK_SHEET, BOOKINGS_COPY } from "../src/lib/bookingsCopy";
import {
  BOOK_CONFIRM, BOOK_PLAYERS, BOOK_SPLIT, PICKER, PLAYERS_REFUSAL,
} from "../src/lib/playersCopy";
import { splitShares } from "../src/components/bookings/splitMath";

/**
 * P11 — booking WITH players, where a member meets it (D11): the BookSheet's Players step (the
 * picker in place), the Split step's live totals from the server, the Confirm sentence, the
 * booking itself, and the open seat's invite link to share. Plus the two things that must not
 * change: "Just me" books exactly as it always did, and a batch refused for its players books
 * nothing at all.
 *
 * <p>
 * Screenshots of every new screen, both themes, at 375 and 1440, go to the lane's scratch
 * directory (`P11_SHOTS`), never into the repo.
 * </p>
 */

const SHOTS = process.env.P11_SHOTS ?? "";

// A walk is three steps, two debounces and a cold dev-server compile on the first test.
test.describe.configure({ timeout: 60_000 });
const COURT_1 = "aaaaaaaa-0000-4000-8000-00000000000a";
const COURT_2 = "aaaaaaaa-0000-4000-8000-00000000000b";

function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Two courts, one free hour each, 100 cr a slice — the playersKit's 100 cr court. */
function day() {
  return {
    date: tomorrow(), timezone: "UTC", sliceMinutes: 15,
    dayStartMinute: 7 * 60, dayEndMinute: 8 * 60,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15,
    courts: [
      { id: COURT_1, courtNumber: 1, name: "Court 1", slicePriceCredits: 100 },
      { id: COURT_2, courtNumber: 2, name: "Court 2", slicePriceCredits: 100 },
    ],
    slots: [],
    rules: {
      groups: [], allowedWindows: [{ start: "07:00", end: "08:00" }],
      clubHours: { start: "07:00", end: "08:00" },
      slicePriceCredits: 100, remainingToday: null, adminExempt: false,
    },
  };
}

type PreviewBody = {
  priceCredits: number; splitMode: "equal" | "ratio" | "amount"; organiserWeight?: number;
  players: { seat: number; guestName?: string; weight?: number; amount?: number }[];
};

/** The split as the server makes it — the backend's rules, through the phone's own mirror. */
function previewAnswer(body: unknown) {
  const b = body as PreviewBody;
  const seats = b.players.map((p) => ({ seat: p.seat, isGuest: p.guestName !== undefined, weight: p.weight, amount: p.amount }));
  const r = splitShares(b.priceCredits, b.splitMode, b.organiserWeight ?? 1, seats);
  if (!r.ok) return { error: r.error };
  const shares = r.shares.map((s) => ({ seat: s.seat, team: s.seat <= 2 ? "A" : "B", share_credits: s.share, weight: s.weight }));
  return { price_credits: b.priceCredits, shares };
}

const OPEN_PATH = "/j/OPENOPENOPENOPENOPEN1";

function routes(extra: ApiRoute[] = [], wallet?: Record<string, unknown>): ApiRoute[] {
  return [
    ...memberShellRoutes({ wallet }),
    { path: "/api/v1/schedule", body: day() },
    { path: "/api/v1/me/partners/favourites", body: { items: [PEOPLE.sam] } },
    { path: "/api/v1/me/partners/recent", body: { items: [{ ...PEOPLE.alex, last_played_at: new Date().toISOString(), games: 3 }] } },
    { path: "/api/v1/members/directory", body: { items: [PEOPLE.jo] } },
    { method: "POST", path: "/api/v1/players/split-preview", respond: ({ body }) => previewAnswer(body) },
    ...extra,
  ];
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

async function openSheet(page: Page) {
  await page.goto("/bookings");
  await page.getByRole("button", { name: /^Book Court 1 at 07:00/ }).first().click();
  await expect(page.getByRole("dialog", { name: BOOK_SHEET.title(1) })).toBeVisible();
}

async function next(page: Page) {
  await page.getByRole("button", { name: BOOK_SHEET.next }).click();
  // The sheet ignores a Book pressed within 300 ms of the step changing.
  await page.waitForTimeout(350);
}

/** Sam (a favourite) in seat 2, an open link seat in seat 4. */
async function seatSamAndALink(page: Page, capture?: (name: string) => Promise<void>) {
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: BOOK_PLAYERS.withOthers }).click();
  await sheet.getByRole("button", { name: BOOK_SEATS.addToSeat(2) }).click();
  await expect(sheet.getByRole("heading", { name: BOOK_SEATS.pickerTitle(2) })).toBeVisible();
  await expect(sheet.getByRole("button", { name: PICKER.add(PEOPLE.sam.name) })).toBeVisible();
  await capture?.("picker-favourites");
  await sheet.getByRole("tab", { name: PICKER.recent }).click();
  await expect(sheet.getByRole("button", { name: PICKER.add(PEOPLE.alex.name) })).toBeVisible();
  await capture?.("picker-recent");
  await sheet.getByRole("tab", { name: PICKER.members }).click();
  await sheet.getByLabel(PICKER.searchLabel).fill("jo");
  await expect(sheet.getByRole("button", { name: PICKER.add(PEOPLE.jo.name) })).toBeVisible();
  await capture?.("picker-members");
  await sheet.getByRole("tab", { name: PICKER.guest }).click();
  await capture?.("picker-guest");
  await sheet.getByRole("tab", { name: PICKER.link }).click();
  await capture?.("picker-link");
  await sheet.getByRole("tab", { name: PICKER.favourites }).click();
  await sheet.getByRole("button", { name: PICKER.add(PEOPLE.sam.name) }).click();
  await sheet.getByRole("button", { name: BOOK_SEATS.addToSeat(4) }).click();
  await sheet.getByRole("tab", { name: PICKER.link }).click();
  await sheet.getByRole("button", { name: PICKER.linkAdd }).click();
  await expect(sheet.locator("[data-court]")).toContainText("Sam");
  await capture?.("players-step");
}

const BOOKED_WITH_PLAYERS = {
  booking_id: "bk-1", balance_after_credits: 20, players_error: null,
  players: {
    booking_id: "bk-1",
    participants: [
      { participant_id: "p2", seat: 2, user_id: SAM, guest_name: null, status: "invited", share_credits: 33, invite_token: "t2", invite_path: "/j/SAMSAMSAMSAMSAMSAMSAM" },
      { participant_id: "p4", seat: 4, user_id: null, guest_name: null, status: "invited", share_credits: 33, invite_token: "t4", invite_path: OPEN_PATH },
    ],
  },
};

test.describe("booking with players", () => {
  test("a member books with Sam and an open seat, split equally, and shares the link", async ({ page }) => {
    let sent: unknown = null;
    await signIn(page);
    await serveApi(page, routes([
      { method: "POST", path: "/api/v1/bookings/", respond: ({ body }) => { sent = body; return BOOKED_WITH_PLAYERS; } },
    ]));
    await openSheet(page);
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("radio", { name: BOOK_PLAYERS.justMe })).toHaveAttribute("aria-checked", "true");
    await seatSamAndALink(page);
    await next(page);

    const totals = sheet.getByRole("region", { name: BOOK_SPLIT.totalsLabel });
    await expect(totals).toContainText(BOOK_SPLIT.youPayNow("100.00 cr", "66.00 cr"));
    await expect(totals).toContainText("34.00 cr");
    await next(page);

    await expect(sheet.getByText("You pay 100.00 cr now; Sam and whoever takes your link are asked for 33.00 cr each.")).toBeVisible();
    // Spendable, not raw: 100 of the 120 cr balance, with the 20 cr held said under it.
    await expect(sheet.locator("dl")).toContainText(`${BOOK_SHEET.balanceNow}100.00 cr`);
    await expect(sheet.locator("[data-held-line]")).toContainText("20.00 cr held until");

    await page.evaluate(() => {
      (window as unknown as { __shared: unknown[] }).__shared = [];
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: (data: unknown) => { (window as unknown as { __shared: unknown[] }).__shared.push(data); return Promise.resolve(); },
      });
    });
    await sheet.getByRole("button", { name: BOOK_SHEET.primary(1, 100, null) }).click();
    await expect(sheet.getByText(BOOK_SHEET.bookedTitle(1, 1))).toBeVisible();
    expect(sent).toMatchObject({ players: [{ userId: SAM, seat: 2 }, { link: true, seat: 4 }], splitMode: "equal" });

    await sheet.getByRole("button", { name: BOOK_CONFIRM.shareLink }).click();
    const shared = await page.evaluate(() => (window as unknown as { __shared: { url: string }[] }).__shared);
    expect(shared).toHaveLength(1);
    expect(shared[0].url).toMatch(new RegExp(`${OPEN_PATH}$`));
    await expect(sheet.getByRole("link", { name: BOOK_CONFIRM.seeBooking })).toHaveAttribute("href", "/bookings/bk-1");
  });

  test("D12 — the sheet's top edge stays put as the picker's tabs change; D3 — the slot is named on Players", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page);
    await serveApi(page, routes());
    await openSheet(page);
    const sheet = page.getByRole("dialog");
    // D3 — the court, the time and the price before Confirm.
    const summary = sheet.getByRole("list", { name: BOOK_SHEET.summaryLabel });
    await expect(summary).toContainText("Court 1");
    await expect(summary).toContainText("100.00 cr");

    await sheet.getByRole("radio", { name: BOOK_PLAYERS.withOthers }).click();
    await sheet.getByRole("button", { name: BOOK_SEATS.addToSeat(3) }).click();
    await expect(sheet.getByRole("button", { name: PICKER.add(PEOPLE.sam.name) })).toBeVisible();
    const top = async () => (await sheet.boundingBox())!.y;
    const first = await top();
    for (const name of [PICKER.recent, PICKER.members, PICKER.link, PICKER.guest, PICKER.favourites]) {
      await sheet.getByRole("tab", { name }).click();
      await page.waitForTimeout(150);
      expect(Math.abs((await top()) - first), `top edge after ${name}`).toBeLessThanOrEqual(1);
    }
  });

  test("Just me still books exactly as before", async ({ page }) => {
    let raw: unknown = null;
    await signIn(page);
    await serveApi(page, routes([
      { method: "POST", path: "/api/v1/bookings/", respond: ({ body }) => { raw = body; return { booking_id: "bk-2", balance_after_credits: 20 }; } },
    ]));
    await openSheet(page);
    await next(page);
    await page.getByRole("dialog").getByRole("button", { name: BOOK_SHEET.primary(1, 100, null) }).click();
    await expect(page.getByRole("dialog").getByText(BOOK_SHEET.bookedTitle(1, 1))).toBeVisible();
    expect(Object.keys(raw as object).sort()).toEqual(["courtId", "sliceCount", "startsAt"]);
    await expect(page.locator("[data-result-players]")).toHaveCount(0);
  });

  test("a batch refused for its players books nothing, and stays on Confirm", async ({ page }) => {
    let bulkCalls = 0;
    await signIn(page);
    await serveApi(page, routes([
      { method: "POST", path: "/api/v1/bookings/bulk", status: 404, respond: () => { bulkCalls += 1; return { error: "member_not_found", user_id: SAM }; } },
    ], { balance_credits: 500, held_credits: 0, spendable_credits: 500, held_until: null }));
    await page.goto("/bookings");
    await page.getByRole("button", { name: BOOKINGS_COPY.selectOn }).click();
    await page.getByRole("button", { name: /^Book Court 1 at 07:00/ }).click();
    await page.getByRole("button", { name: /^Book Court 2 at 07:00/ }).click();
    await page.getByRole("toolbar", { name: "Selected slots" }).getByRole("button", { name: BOOKINGS_COPY.bookSelection }).click();
    const sheet = page.getByRole("dialog", { name: BOOK_SHEET.title(2) });
    await sheet.getByRole("radio", { name: BOOK_PLAYERS.withOthers }).click();
    await sheet.getByRole("button", { name: BOOK_SEATS.addToSeat(3) }).click();
    await sheet.getByRole("button", { name: PICKER.add(PEOPLE.sam.name) }).click();
    await next(page);
    await expect(sheet.getByText(BOOK_SPLIT.eachBooking)).toBeVisible();
    await next(page);
    await expect(sheet.getByText("On each booking you pay 100.00 cr now; Sam is asked for 50.00 cr.")).toBeVisible();
    await sheet.getByRole("button", { name: BOOK_SHEET.primary(2, 200, null) }).click();
    await expect(sheet.getByText(PLAYERS_REFUSAL.member_not_found)).toBeVisible();
    expect(bulkCalls).toBe(1);
    await expect(sheet.getByRole("button", { name: BOOK_SHEET.primary(2, 200, null) })).toBeVisible();
    await expect(sheet.locator("[data-bulk-results]")).toHaveCount(0);
  });
});

/**
 * The screenshots — once, from the mobile project, at the two widths the brief names, in both
 * themes. Not assertions: the lane looks at every one of them.
 */
test.describe("screens", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [375, 1440]) {
      test(`players, split, confirm and result at ${width} in ${theme}`, async ({ page }, info) => {
        test.skip(!SHOTS || info.project.name !== "mobile", "screenshots are taken once, when asked for");
        await page.setViewportSize({ width, height: width < 640 ? 812 : 900 });
        await page.addInitScript((t) => window.localStorage.setItem("crusaders:theme", t), theme);
        await signIn(page);
        await serveApi(page, routes([{ method: "POST", path: "/api/v1/bookings/", body: BOOKED_WITH_PLAYERS }]));
        await openSheet(page);
        const tag = (name: string) => `${name}-${width}-${theme}`;
        await shot(page, tag("players-just-me"));
        await seatSamAndALink(page, (name) => shot(page, tag(name)));
        await next(page);
        const sheet = page.getByRole("dialog");
        await expect(sheet.getByRole("region", { name: BOOK_SPLIT.totalsLabel })).toContainText("66.00 cr");
        await shot(page, tag("split-equal"));
        await sheet.getByRole("radio", { name: BOOK_SPLIT.modes.ratio }).click();
        await sheet.getByLabel(BOOK_SPLIT.weightLabel("Sam")).fill("2");
        await expect(sheet.getByRole("region", { name: BOOK_SPLIT.totalsLabel })).toBeVisible();
        await page.waitForTimeout(400);
        await shot(page, tag("split-ratio"));
        await sheet.getByRole("radio", { name: BOOK_SPLIT.modes.amount }).click();
        await sheet.getByLabel(BOOK_SPLIT.amountLabel("Sam")).fill("90");
        await sheet.getByLabel(BOOK_SPLIT.amountLabel(BOOK_PLAYERS.linkName)).fill("20");
        await expect(sheet.getByText(PLAYERS_REFUSAL.split_exceeds_price)).toBeVisible();
        await shot(page, tag("split-amount-exceeds"));
        await sheet.getByRole("radio", { name: BOOK_SPLIT.modes.equal }).click();
        await expect(sheet.getByRole("region", { name: BOOK_SPLIT.totalsLabel })).toContainText("66.00 cr");
        await next(page);
        await expect(sheet.locator("[data-confirm-sentence]")).toBeVisible();
        await shot(page, tag("confirm"));
        await sheet.getByRole("button", { name: BOOK_SHEET.primary(1, 100, null) }).click();
        await expect(sheet.getByRole("button", { name: BOOK_CONFIRM.shareLink })).toBeVisible();
        await page.waitForTimeout(300);
        await shot(page, tag("result"));
      });
    }
  }
});
