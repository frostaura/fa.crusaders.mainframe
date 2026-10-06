import type { Locator, Page } from "@playwright/test";
import { SESSION_ADMIN, serveApi, signIn, test, expect, type ApiRoute } from "./fixtures";
import { BOOKING, CLUB_ZONE, ME, PEOPLE, PROFILE_ME, detailFixture, memberShellRoutes, seat, tomorrowAt } from "./playersKit";
import { BOOK_SHEET, CANCEL_SHEET } from "../src/lib/bookingsCopy";
import { CONFLICT_UNSURE_TEXT, UNSURE_TEXT } from "../src/lib/bookingErrors";
import { BOOK_SHEET_GONE } from "../src/lib/gridCopy";
import { ADMIN_TOUR, ADMIN_TOUR_PATH } from "../src/lib/onboardingCopy";

test.describe.configure({ timeout: 120_000 });

/**
 * Review round 18, lane FE18s — the bookings sheets, the door card and the admin tour, measured in
 * Chromium at the sizes the reviewers used.
 *
 * <ul>
 *   <li><b>L18-1</b> (the sheets' sibling) — the cancel / book sheet's slot tile at 320 / 200 %: the
 *   racquet box is capped in pixels (it was 80 px of a 236 px card), and no word in the row is split
 *   across two lines.</li>
 *   <li><b>L18-2</b> — a sheet's refusal at 320 / 200 % is on screen and holds the keyboard (cancel's
 *   clash, book's lost answer); a gone slot keeps "Pick another time" focused, the refusal on screen.</li>
 *   <li><b>L18-3</b> — the Split step's names are whole beside or above their inputs, and its mode
 *   toggles hold their words.</li>
 *   <li><b>L18-5</b> — the door card never splits an ordinary word ("break-all" did); a long email
 *   still stays inside the card.</li>
 *   <li><b>L18-6</b> — on a phone and a tablet the tour's mark stays on screen, Next and Close
 *   reachable, after the page is scrolled its anchor away.</li>
 * </ul>
 */

const ARRIVES = { timeout: 45_000 };

/** 200 % text: a 32px root from the first paint. */
async function bigText(page: Page, px = 32) {
  await page.addInitScript((size) => document.addEventListener("DOMContentLoaded", () => {
    document.documentElement.style.fontSize = `${size}px`;
  }), px);
}

/** Words (whitespace-separated runs) under `root` whose letters land on more than one line. */
async function splitWords(root: Locator): Promise<string[]> {
  return root.evaluate((el) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      const re = /\S+/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        if (tops.size > 1) out.push(m[0]);
      }
    }
    return out;
  });
}

/** Is `el` inside the viewport and the topmost thing at its own top-left corner? */
async function onScreen(target: Locator) {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + 4));
    const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + 4));
    const hit = document.elementFromPoint(x, y);
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, topmost: Boolean(hit && el.contains(hit)) };
  });
}

/* ─────────────────────────────── the Bookings page ─────────────────────────────── */

const COURTS = [1, 2, 3, 4].map((n) => ({ id: `c${n}`, courtNumber: n, name: `Court ${n}`, slicePriceCredits: 15 }));

function schedule(slots: unknown[] = []) {
  return {
    date: tomorrowAt(10).slice(0, 10), timezone: CLUB_ZONE, sliceMinutes: 15, dayStartMinute: 360, dayEndMinute: 1320,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 120, courts: COURTS, slots,
  };
}

const OWN_SLOT = {
  courtId: "c2", courtNumber: 2, startsAtUtc: tomorrowAt(18), endsAtUtc: tomorrowAt(18, 45), bookingId: BOOKING, isMine: true,
  ownerUserId: ME, ownerFirstName: "Nomsa", ownerPhotoUrl: null, checkedIn: null, amountChargedMinutes: 45, status: "booked",
};

const QUOTE = {
  bookingId: BOOKING, amountChargedMinutes: 45, refundMinutes: 45, penaltyMinutes: 0, penaltyPct: 30,
  penaltyWindowMinutes: 120, insidePenaltyWindow: false, checkedIn: false, alreadyStarted: false,
};

function bookingsRoutes(extra: ApiRoute[]): ApiRoute[] {
  return [
    ...extra,
    ...memberShellRoutes(),
    { path: "/api/v1/me/preferences", body: {} },
    { path: "/api/v1/me/bookings/upcoming", body: { timezone: CLUB_ZONE, items: [] } },
    { path: "/api/v1/me/bookings/recent", body: { timezone: CLUB_ZONE, items: [] } },
    { path: `/api/v1/bookings/${BOOKING}`, body: detailFixture() },
  ];
}

async function openBookings(page: Page, extra: ApiRoute[], width = 320, height = 640) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await signIn(page);
  await serveApi(page, bookingsRoutes(extra));
  await bigText(page);
  await page.goto(`/bookings?date=${tomorrowAt(10).slice(0, 10)}`);
}

async function openCancel(page: Page, extra: ApiRoute[] = []) {
  await openBookings(page, [
    { path: "/api/v1/schedule", body: schedule([OWN_SLOT]) },
    { path: `/api/v1/bookings/${BOOKING}/cancellation-quote`, body: QUOTE },
    ...extra,
  ]);
  const cell = page.locator("[role=grid]").getByRole("button", { name: /Court 2 at 18:00/ }).first();
  await expect(cell).toBeVisible(ARRIVES);
  await cell.click();
  const sheet = page.getByRole("dialog", { name: CANCEL_SHEET.title(1) });
  await expect(sheet.getByRole("button", { name: CANCEL_SHEET.confirm(1) })).toBeVisible(ARRIVES);
  return sheet;
}

/** The member's Book sheet on a free 18:00 slot of Court 3, at the Confirm step. */
async function openBookConfirm(page: Page, extra: ApiRoute[]) {
  await openBookings(page, extra);
  const cell = page.locator("[role=grid]").getByRole("button", { name: /^Book Court 3 at 18:00/ }).first();
  await expect(cell).toBeVisible(ARRIVES);
  await cell.click();
  const sheet = page.getByRole("dialog", { name: BOOK_SHEET.title(1) });
  await sheet.getByRole("button", { name: BOOK_SHEET.next }).click();
  await page.waitForTimeout(400); // the sheet's own double-tap guard after a step change
  return sheet;
}

/* ─────────────────────────────── L18-1 ─────────────────────────────── */

test("L18-1 — the cancel sheet's slot tile at 320 / 200 %: a capped racquet box, no word split", async ({ page }) => {
  const sheet = await openCancel(page);
  const row = sheet.locator("ul li").first();
  const icon = await row.locator("span[aria-hidden=true]").first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: Math.round(r.width), display: getComputedStyle(el).display };
  });
  expect(icon.display === "none" || icon.width <= 48, `racquet box ${icon.width}px`).toBe(true);
  expect(await splitWords(row)).toEqual([]);
});

/* ─────────────────────────────── L18-2 ─────────────────────────────── */

test("L18-2 — cancel: a clash the schedule shows did not cancel is on screen and focused at 320 / 200 %", async ({ page }) => {
  const sheet = await openCancel(page, [
    { method: "POST", path: `/api/v1/bookings/${BOOKING}/cancel`, status: 503, body: { error: "conflict_retry" } },
  ]);
  await sheet.getByRole("button", { name: CANCEL_SHEET.confirm(1) }).click();
  const refusal = sheet.locator("[data-sheet-refusal]");
  await expect(refusal).toHaveText(new RegExp(CONFLICT_UNSURE_TEXT.cancel.checked.slice(0, 40)), ARRIVES);
  await expect(refusal).toBeFocused();
  const at = await onScreen(refusal);
  expect(at.top, JSON.stringify(at)).toBeGreaterThanOrEqual(0);
  expect(at.top).toBeLessThan(at.vh);
  expect(at.topmost, "nothing covers the refusal").toBe(true);
});

test("L18-2 — book: a lost answer is on screen and focused at 320 / 200 %", async ({ page }) => {
  const sheet = await openBookConfirm(page, [
    { path: "/api/v1/schedule", body: schedule() },
    { method: "POST", path: "/api/v1/bookings/", status: 503, body: {} },
  ]);
  await sheet.getByRole("button", { name: /^Book · / }).click();
  const refusal = sheet.locator("[data-sheet-refusal]");
  await expect(refusal).toHaveText(new RegExp(UNSURE_TEXT.book.checked.slice(0, 40)), ARRIVES);
  await expect(refusal).toBeFocused();
  const at = await onScreen(refusal);
  expect(at.top, JSON.stringify(at)).toBeGreaterThanOrEqual(0);
  expect(at.topmost, "nothing covers the refusal").toBe(true);
});

test("L18-2 — book: a slot taken keeps 'Pick another time' focused, the refusal on screen", async ({ page }) => {
  let posted = false;
  const taken = { ...OWN_SLOT, courtId: "c3", courtNumber: 3, bookingId: "b0000000-0000-0000-0000-0000000000ff", isMine: false, ownerUserId: "someone-else", ownerFirstName: "Pia" };
  const sheet = await openBookConfirm(page, [
    { path: "/api/v1/schedule", respond: () => schedule(posted ? [taken] : []) },
    { method: "POST", path: "/api/v1/bookings/", status: 409, respond: () => { posted = true; return { error: "slot_taken" }; } },
  ]);
  await sheet.getByRole("button", { name: /^Book · / }).click();
  const pick = sheet.getByRole("button", { name: BOOK_SHEET_GONE.pickAnother });
  await expect(pick).toBeFocused(ARRIVES);
  const refusal = sheet.locator("[data-sheet-refusal]");
  await expect(refusal).toBeVisible();
  await page.waitForTimeout(300);
  const at = await onScreen(refusal);
  expect(at.top, JSON.stringify(at)).toBeGreaterThanOrEqual(0);
  expect(at.top).toBeLessThan(at.vh);
  expect(at.topmost, "nothing covers the refusal").toBe(true);
  await expect(pick).toBeFocused();
});

/* ─────────────────────────────── L18-3 ─────────────────────────────── */

const DETAIL = `/api/v1/bookings/${BOOKING}`;

function longNamedDetail() {
  const base = detailFixture();
  const players = (base.players as Record<string, unknown>[]).map((p) => {
    if (p.seat === 2) return { ...p, name: "Bongani Mthembu" };
    if (p.seat === 3) return seat({ ...p, name: "Charlotte Pemberton", status: "accepted" });
    return p;
  });
  return { ...base, organiser: PEOPLE.me, players };
}

for (const [width, root] of [[320, 32], [390, 32], [390, 16]] as const) {
  test(`L18-3 — the Split step at ${width} / ${root * 100 / 16} %: names whole, inputs inside, modes in their boxes`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);
    await serveApi(page, [
      { path: DETAIL, body: longNamedDetail() },
      {
        method: "POST", path: "/api/v1/players/split-preview",
        respond: ({ body }) => {
          const req = body as { priceMinutes: number; players: { seat: number }[] };
          const partners = req.players.map((p) => ({ seat: p.seat, team: p.seat <= 2 ? "A" : "B", share_minutes: 25, weight: 1 }));
          return { price_minutes: req.priceMinutes, shares: [{ seat: 1, team: "A", share_minutes: req.priceMinutes - 25 * partners.length, weight: 1 }, ...partners] };
        },
      },
      ...memberShellRoutes(),
    ]);
    if (root !== 16) await bigText(page, root);
    await page.goto(`/bookings/${BOOKING}`);
    await page.getByRole("button", { name: "Change split" }).click();
    const dialog = page.getByRole("dialog", { name: "Change the split" });
    await expect(dialog).toBeVisible(ARRIVES);
    // The mode toggles hold their words.
    const modes = await dialog.getByRole("radio").evaluateAll((els) => els.map((el) => ({
      text: el.textContent?.trim(), over: el.scrollWidth - el.clientWidth,
    })));
    for (const m of modes) expect(m.over, `"${m.text}" spills its toggle`).toBeLessThanOrEqual(1);
    for (const mode of ["Ratio", "Amount"]) {
      await dialog.getByRole("radio", { name: mode }).click();
      const list = dialog.locator("ul[aria-label]").filter({ has: page.locator("input") }).first();
      await expect(list).toBeVisible();
      const fields = await list.locator("input").evaluateAll((inputs) => inputs.map((input) => {
        const field = input.closest("[data-slot=field]") ?? input.parentElement!;
        const label = field.querySelector("label")!;
        const box = field.closest("ul")!.getBoundingClientRect();
        const ir = input.getBoundingClientRect();
        return {
          label: label.textContent?.trim(), cut: label.scrollWidth - label.clientWidth,
          inputIn: ir.left >= box.left - 1 && ir.right <= box.right + 1, inputWidth: Math.round(ir.width),
        };
      }));
      expect(fields.length).toBeGreaterThan(0);
      for (const f of fields) {
        expect(f.cut, `${mode}: "${f.label}" is cut`).toBeLessThanOrEqual(0);
        expect(f.inputIn, `${mode}: ${f.label}'s input leaves its card`).toBe(true);
      }
      expect(await splitWords(list), `${mode}: a name split across lines`).toEqual([]);
    }
  });
}

/* ─────────────────────────────── L18-5 ─────────────────────────────── */

const DOOR_ID = "99999999-9999-9999-9999-999999999999";

function doorRoutes(): ApiRoute[] {
  const door = {
    id: DOOR_ID, device_code: "gate-0a1b2c", name: "Side door", kind: "Gate", hardware: "Esp32", court_numbers: [],
    gate_key: "side-door", mac_address: "5ccf7f0a1b2c", enabled: true, last_seen_at: new Date().toISOString(),
    last_ip_address: "192.168.68.160", running_version: "1.0.0", mega_version: null, created_at: new Date().toISOString(),
    auto_registered: false, effective_heartbeat_seconds: 60,
    location_note: "In the cupboard above the fuse board, behind the squash racquet rack",
    power_loss_behaviour: "released", out_of_service_since: null,
  };
  return [
    { path: "/api/v1/whoami", body: SESSION_ADMIN },
    { path: "/api/v1/me/profile", body: { full_name: "Crusaders Admin", email: "admin@sample.local", photo_url: null, membership_number: "ADMIN-0001" } },
    { path: "/api/v1/wallet", body: { balance_minutes: 0, entries: [], count: 0 } },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/settings/", body: {
      timezone: "Africa/Johannesburg", club_contact_phone: "076 226 1390",
      club_contact_email: "membership.secretary.northwoodcrusaders@example.co.za",
    } },
    { path: "/api/v1/admin/doors", body: {
      day_started_at: new Date().toISOString(), timezone: "Africa/Johannesburg", shut_all_active: false,
      shut_together: [], shut_individually: [], doors: [{ device: door, today: { released: 0, refused: 0 }, signals: [] }],
    } },
  ];
}

test("L18-5 — the door card at 320 / 200 % splits no ordinary word, and the email stays inside", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await signIn(page);
  await serveApi(page, doorRoutes());
  await bigText(page);
  await page.goto(`/admin/doors/${DOOR_ID}/card`);
  const where = page.getByText(/In the cupboard above the fuse board/);
  await expect(where).toBeVisible(ARRIVES);
  const ordinary = (await splitWords(where)).filter((w) => !w.includes("@"));
  expect(ordinary, "ordinary words split").toEqual([]);
  const power = page.getByText(/this is a property of the lock/);
  expect((await splitWords(power)).filter((w) => !w.includes("@"))).toEqual([]);
  const email = page.getByText(/membership\.secretary/);
  await expect(email).toBeVisible();
  const spill = await email.evaluate((el) => {
    const card = el.closest("section")!.parentElement!.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    return Math.max(0, ...[...range.getClientRects()].map((r) => r.right - card.right));
  });
  expect(spill, "the email runs past the card").toBeLessThanOrEqual(1);
});

/* ─────────────────────────────── L18-6 ─────────────────────────────── */

function tourRoutes(): ApiRoute[] {
  const prefs = {
    theme: "system", member_onboarding_completed_at: null, member_onboarding_dismissed_at: "2026-09-01T10:00:00Z",
    admin_onboarding_completed_at: "2026-09-01T10:00:00Z", admin_onboarding_dismissed_at: null,
  };
  return [
    ...memberShellRoutes({ admin: true }),
    { path: "/api/v1/me/profile", body: { ...PROFILE_ME, is_admin: true, status: "active", preferences: prefs } },
    { path: "/api/v1/me/preferences", body: { ...prefs, findable: false, show_in_leaderboards: false } },
    { method: "POST", path: "/api/v1/me/onboarding/admin/complete", body: prefs },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/monitoring/summary", body: { open: {} } },
    { path: "/api/v1/admin/doors", body: { day_started_at: "2026-09-23T00:00:00Z", timezone: "Africa/Johannesburg", shut_all_active: false, doors: [] } },
  ];
}

for (const [width, height, root] of [[390, 640, 32], [390, 700, 16], [768, 700, 32]] as const) {
  test(`L18-6 — at ${width} / ${root * 100 / 16} % the tour's mark stays on screen when the page scrolls its anchor away`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await signIn(page);
    await serveApi(page, tourRoutes());
    if (root !== 16) await bigText(page, root);
    await page.goto(ADMIN_TOUR_PATH);
    const mark = page.getByRole("dialog", { name: ADMIN_TOUR.stops[0].title });
    await expect(mark).toBeVisible(ARRIVES);
    // Scroll every scroller that can (the document and the shell's <main>) to its end.
    const scrolled = await page.evaluate(() => {
      const els = [document.scrollingElement, ...document.querySelectorAll("main")].filter(Boolean) as Element[];
      let moved = 0;
      for (const el of els) {
        const before = el.scrollTop;
        el.scrollTop = el.scrollHeight;
        moved += el.scrollTop - before;
      }
      return moved;
    });
    expect(scrolled, "the page scrolled").toBeGreaterThan(100);
    await page.waitForTimeout(500);
    const box = (await mark.boundingBox())!;
    expect(box.y + box.height, "the mark's foot is above the bottom").toBeLessThanOrEqual(height + 1);
    expect(box.y, "the mark's head is below the top").toBeGreaterThanOrEqual(-1);
    for (const name of [ADMIN_TOUR.next, ADMIN_TOUR.close]) {
      const button = mark.getByRole("button", { name, exact: true });
      const at = await onScreen(button);
      expect(at.topmost && at.top >= 0 && at.bottom <= at.vh, `${name}: ${JSON.stringify(at)}`).toBe(true);
    }
    await mark.getByRole("button", { name: ADMIN_TOUR.next, exact: true }).click();
    await expect(page.getByRole("dialog", { name: ADMIN_TOUR.stops[1].title })).toBeVisible();
  });
}
