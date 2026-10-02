import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
// Renamed on import: it plants a token, it is not a React hook, and the hooks rule reads names.
import {
  adjustCredits, devAdminSession, findMember, approveMember, passwordSession, useSession as plantSession, type Session,
} from "./support/api";
import { avatarFile, uniqueEmail, uniqueMembershipNumber, walkPassword } from "./support/ids";
import { rehome, verificationLink, waitForMailMatch } from "./support/mailhog";
import { INBOX_HEADING, VERIFY_OK_HEADING } from "../src/lib/registrationCopy";
import { ADMIN_RESULTS, CELEBRATION_COPY, CONFIRM_SHEET, MY_GAME, RESULT_CARD, RESULT_SHEET } from "../src/lib/playCopy";

/**
 * P12 — the play walk against the REAL stack (`docs/specs/play.md` §11, e2e-real), run after
 * the backend and frontend lanes are integrated:
 *
 * <ol>
 *   <li>an organiser and a partner (two fresh members) book a court for now, the partner on it;</li>
 *   <li>the court is checked in THROUGH THE DEVICE API — a box heartbeats, takes the booking's
 *   code off its roster and activates it — because a result is recordable only once the box saw
 *   the session (§3.1), never on a door scan or the clock;</li>
 *   <li>the organiser records 3–1 in the sheet; the partner opens the MailHog link
 *   (`?result=confirm`) and confirms; both see "First win" / "On the record" under My game;</li>
 *   <li>in a second game the partner disputes; the admin finds it on /admin/results and removes it.</li>
 * </ol>
 *
 * <p>
 * Setup is API-first (the journeys under test are the play screens), members are registered
 * through the real register form so the photo rule is the club's own, and every refusal names
 * the step that made it. Needs the Development stack with MailHog: `make up`.
 * </p>
 *
 * <p>
 * <b>No wall-clock waits.</b> The booking starts {@link LEAD_MS} from now rather than on the next
 * slice boundary — the booking API takes any start that has not passed — so the box's cue window
 * (`StartsAt − activation_cue_window_minutes`) is already open when the box scans, and the court
 * time has started a few seconds later. It used to wait for the next boundary and then for the cue
 * to open: about 30 minutes per viewport. Both viewports run at once (`mobile-play` and
 * `desktop-play`, playwright.real.config.ts), each with its own members and searching the courts
 * from opposite ends so the two never race for the same one.
 * </p>
 */

type Member = { email: string; password: string; name: string; session: Session };

function bearer(session: Session): Record<string, string> {
  return { Authorization: `Bearer ${session.accessToken}` };
}

async function ok<T>(res: Awaited<ReturnType<APIRequestContext["get"]>>, what: string): Promise<T> {
  if (!res.ok()) throw new Error(`${what} failed: HTTP ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Do something in the page that calls an anonymous auth route, and do it again after the
 * limiter's `Retry-After` if the route answered 429. The limit is 10 a minute per IP, and this
 * walk registers two members per test in two viewports — four walks' worth of sign-ups inside
 * a couple of minutes. A 429 is refused before the handler runs, so the token is still good.
 */
async function politely(page: Page, route: string, act: () => Promise<unknown>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const answer = page.waitForResponse((r) => r.url().includes(route) && r.request().method() === "POST");
    await act();
    const res = await answer;
    if (res.status() !== 429 || attempt >= 4) return;
    const wait = Number(res.headers()["retry-after"] ?? "20");
    await page.waitForTimeout(Math.min(Math.max(wait, 5), 65) * 1_000);
  }
}

/** A member who registered through the form, confirmed their email and was approved. */
async function newMember(page: Page, request: APIRequestContext, baseURL: string, name: string): Promise<Member> {
  const email = uniqueEmail("play");
  const password = walkPassword();
  await page.goto("/register");
  await page.getByLabel(/full name/i).fill(name);
  await page.getByLabel(/^email/i).fill(email);
  await page.getByLabel(/membership number/i).fill(uniqueMembershipNumber());
  await page.getByLabel(/^password/i).fill(password);
  await page.locator('input[type="file"]').first().setInputFiles(avatarFile());
  const submit = page.getByRole("button", { name: /submit|apply|join/i });
  await expect(submit).toBeEnabled();
  await expect(submit).not.toHaveText(/preparing/i);
  await politely(page, "/auth/register", () => submit.click());
  await expect(page.getByRole("heading", { name: INBOX_HEADING })).toBeVisible();
  const link = await verificationLink(email, baseURL);
  await politely(page, "/auth/verify-email/", () => page.goto(link));
  await expect(page.getByRole("heading", { name: VERIFY_OK_HEADING })).toBeVisible();
  const admin = await devAdminSession(request);
  await approveMember(request, admin, email);
  const session = await passwordSession(request, email, password);
  await adjustCredits(request, admin, session.userId, 400, "Play walk setup");
  return { email, password, name, session };
}

type Court = { courtId: string; courtNumber: number };

type ScheduleWire = {
  sliceMinutes?: number;
  courts: { id: string; courtNumber: number; isActive?: boolean }[];
  slots: { courtId: string; startsAtUtc: string; endsAtUtc: string; status: string }[];
};

/**
 * One slice: the walk only needs the box to see the session, and every run holds a court until
 * its booking ends — two viewports times two tests is four courts, the whole club.
 */
const SLICES = 1;

/**
 * How far ahead of now the booking starts. `BookingService` refuses a start that has passed
 * (`past_time`) and nothing else about when it falls — there is no slice-grid rule — so a start a
 * few seconds out is bookable, already inside the box's cue window, and started by the time the
 * result is recorded. The margin covers the request's own latency and any skew between this
 * machine's clock and the stack's.
 */
const LEAD_MS = 15_000;

/**
 * A court free for the booking, and the earliest start from {@link LEAD_MS} out that has one: now,
 * or else the moment a busy court frees up. The schedule's court is `{ id, courtNumber }`; the
 * booking body names it `courtId`. The first FREE court, not the first court: earlier runs, the
 * seeder's evening bookings and the other viewport hold some — and the two viewports search from
 * opposite ends so that, running at once, they do not both pick the same one.
 */
async function courtNow(request: APIRequestContext, member: Member): Promise<{ court: Court; startsAt: string; sliceMs: number }> {
  // No `date`: the server answers for the CLUB's today. A UTC date read yesterday's grid after
  // midnight SAST and never saw the courts this walk had just booked (the D2-B33 trap).
  const day = await ok<ScheduleWire>(
    await request.get("/api/v1/schedule", { headers: bearer(member.session) }), "schedule");
  const slice = (day.sliceMinutes ?? 15) * 60_000;
  const earliest = Date.now() + LEAD_MS;
  const live = day.slots.filter((s) => s.status !== "cancelled");
  const candidates = [earliest, ...live.map((s) => Date.parse(s.endsAtUtc)).filter((t) => t > earliest)].sort((a, b) => a - b);
  const courts = day.courts.filter((c) => c.isActive !== false);
  if (test.info().project.name.startsWith("desktop")) courts.reverse();
  for (const from of candidates) {
    const to = from + SLICES * slice;
    const busy = (courtId: string) => live.some((s) => s.courtId === courtId
      && Date.parse(s.startsAtUtc) < to && Date.parse(s.endsAtUtc) > from);
    const free = courts.find((c) => !busy(c.id));
    if (free) return { court: { courtId: free.id, courtNumber: free.courtNumber }, startsAt: new Date(from).toISOString(), sliceMs: slice };
  }
  throw new Error(`no court is free today from ${new Date(earliest).toISOString()}`);
}

/** The organiser books the court for now with the partner on it; the partner says yes. */
async function bookTogether(
  request: APIRequestContext, organiser: Member, partner: Member,
): Promise<{ bookingId: string; court: Court; startsAt: string; endsAt: string }> {
  // The other viewport, running at once, can take the court between the schedule read and the
  // booking when only one is free: `slot_taken` means "look again", a few times.
  const book = (courtId: string, at: string) => request.post("/api/v1/bookings/", {
    headers: bearer(organiser.session),
    data: { courtId, startsAt: at, sliceCount: SLICES, players: [{ userId: partner.session.userId }], splitMode: "equal" },
  });
  let { court, startsAt, sliceMs } = await courtNow(request, organiser);
  let res = await book(court.courtId, startsAt);
  for (let attempt = 2; attempt <= 4 && res.status() === 409 && (await res.text()).includes("slot_taken"); attempt += 1) {
    ({ court, startsAt, sliceMs } = await courtNow(request, organiser));
    res = await book(court.courtId, startsAt);
  }
  const booked = await ok<{ booking_id: string; players?: { participants: { participant_id: string; user_id: string | null }[] } }>(
    res, "book with a partner");
  const seat = booked.players?.participants.find((p) => p.user_id === partner.session.userId);
  if (!seat) throw new Error("the partner's seat was not created");
  const detail = await ok<{ players: { participant_id: string; share_minutes: number }[] }>(
    await request.get(`/api/v1/bookings/${booked.booking_id}`, { headers: bearer(partner.session) }), "partner reads the booking");
  const share = detail.players.find((p) => p.participant_id === seat.participant_id)?.share_minutes ?? 0;
  await ok(await request.post(`/api/v1/bookings/${booked.booking_id}/players/${seat.participant_id}/accept`, {
    headers: bearer(partner.session), data: { expectedShareMinutes: share },
  }), "partner accepts");
  const endsAt = new Date(Date.parse(startsAt) + SLICES * sliceMs).toISOString();
  return { bookingId: booked.booking_id, court, startsAt, endsAt };
}

/**
 * The box sees the session: a board heartbeats (registering itself), is given the booking's
 * court, heartbeats again for a roster, and activates the booking's code — exactly the path a
 * scan takes. This is what sets `bookings.CheckedInAt`; nothing else in the walk does.
 */
// A result can be recorded only once the court time has started (`not_started` before), and the
// box checks a booking in up to the cue window early — so wait out the rest before recording:
// LEAD_MS at most, unless no court was free until one freed up.
async function untilStarted(startsAt: string) {
  const wait = Date.parse(startsAt) - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait + 2_000));
}

async function checkInThroughTheBox(
  request: APIRequestContext, court: Court, bookingId: string, startsAt: string, endsAt: string,
): Promise<void> {
  const admin = await devAdminSession(request);
  // The box lights a booking from `StartsAt − activation_cue_window_minutes`; before that a scan
  // is `too_early`. The booking starts LEAD_MS out, well inside the cue, so this waits only when
  // the club's cue window is shorter than that or no court was free until later.
  const settings = await ok<{ activation_cue_window_minutes?: number }>(
    await request.get("/api/v1/admin/settings", { headers: bearer(admin) }), "settings");
  const cueOpens = Date.parse(startsAt) - (settings.activation_cue_window_minutes ?? 10) * 60_000;
  const wait = cueOpens - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait + 2_000));
  const { api_key: key } = await ok<{ api_key: string }>(
    await request.get("/api/v1/admin/devices/api-key", { headers: bearer(admin) }), "device api key");
  const mac = `5ccf7f${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`;
  const box = (path: string, body: Record<string, unknown>) =>
    request.post(path, { headers: { Authorization: `Bearer ${key}` }, data: { mac, ...body } });
  await ok(await box("/api/v1/device/heartbeat", { firmware_version: "2.0.0", mega_version: "2.0.0", uptime_ms: 5000 }), "first heartbeat");
  const devices = await ok<{ id: string; mac_address: string }[]>(
    await request.get("/api/v1/admin/devices/", { headers: bearer(admin) }), "devices");
  const device = devices.find((d) => d.mac_address === mac);
  if (!device) throw new Error("the box did not register itself");
  await ok(await request.patch(`/api/v1/admin/devices/${device.id}`, {
    headers: bearer(admin), data: { court_numbers: [court.courtNumber] },
  }), "give the box the booking's court");
  const hb = await ok<{ roster?: string[] }>(
    await box("/api/v1/device/heartbeat", { firmware_version: "2.0.0", mega_version: "2.0.0", uptime_ms: 6000 }), "roster heartbeat");
  // `token|relay|opens_in|closes_in`. The box's one court may carry an earlier booking still
  // running, so the entry is the one closing when THIS booking ends, not the first on relay 0.
  const closesIn = (Date.parse(endsAt) - Date.now()) / 1_000;
  const entry = (hb.roster ?? []).map((line) => line.split("|"))
    .find(([, relay, , closes]) => relay === "0" && Math.abs(Number(closes) - closesIn) < 90);
  if (!entry) throw new Error(`no roster entry for the booking's court: ${JSON.stringify(hb.roster)}`);
  const act = await ok<{ activated: boolean; booking_id?: string }>(
    await box("/api/v1/device/activate", { method: "qr", token: entry[0], court: court.courtNumber }), "activate");
  expect(act).toMatchObject({ activated: true, booking_id: bookingId });
}

/**
 * Close every celebration that is up or arrives within a moment. A fresh member earns "First
 * court" from the check-in (the play worker runs once a minute), and the overlay is allowed on
 * a booking page — so it can land on top of the result card mid-walk, as it would for a member.
 */
async function dismissCelebrations(page: Page): Promise<void> {
  const moment = page.locator("[data-celebration]");
  for (let quiet = 0; quiet < 3;) {
    if (await moment.isVisible()) {
      // The next queued moment takes the same dialog's place at once (a walk after 21:00 also
      // earns "Night owl"), so "this one went" is the title changing or the dialog closing.
      const title = await moment.getByRole("heading").first().textContent();
      await moment.getByRole("button", { name: CELEBRATION_COPY.keepPlaying }).click();
      await expect.poll(async () => ((await moment.isVisible()) ? await moment.getByRole("heading").first().textContent() : null))
        .not.toBe(title);
      quiet = 0;
    } else {
      quiet += 1;
      await page.waitForTimeout(700);
    }
  }
}

async function typeGame(page: Page, game: number, a: number, b: number) {
  await page.getByRole("textbox", { name: RESULT_SHEET.scoreFor(game, RESULT_SHEET.sideA) }).fill(String(a));
  await page.getByRole("textbox", { name: RESULT_SHEET.scoreFor(game, RESULT_SHEET.sideB) }).fill(String(b));
}

test.describe.configure({ mode: "serial" });

test("organiser records 3–1, partner confirms from the mail, both earn their badges", async ({ browser, request, baseURL }) => {
  // A couple of minutes normally. The headroom is for the two slow paths the walk still has:
  // the auth limiter's Retry-After (10 anonymous calls a minute, both viewports registering at
  // once) and a club with no court free until one frees up.
  test.setTimeout(1_200_000);
  const base = baseURL ?? "http://localhost:8088";
  const setup = await browser.newPage();
  const organiser = await newMember(setup, request, base, "Play Organiser");
  const partner = await newMember(setup, request, base, "Play Partner");
  await setup.close();

  const { bookingId, court, startsAt, endsAt } = await bookTogether(request, organiser, partner);
  await checkInThroughTheBox(request, court, bookingId, startsAt, endsAt);
  await untilStarted(startsAt);
  // Seconds normally, but a club with no free court waits for one — longer than an access token
  // lives (15 minutes). Signing both back in costs two per-account sign-ins.
  organiser.session = await passwordSession(request, organiser.email, organiser.password);
  partner.session = await passwordSession(request, partner.email, partner.password);

  await test.step("the organiser records the match in the sheet", async () => {
    const page = await browser.newPage();
    await plantSession(page, organiser.session);
    await page.goto(`/bookings/${bookingId}`);
    await dismissCelebrations(page);
    await page.getByRole("button", { name: RESULT_CARD.record }).click();
    await typeGame(page, 1, 11, 7);
    await typeGame(page, 2, 9, 11);
    await typeGame(page, 3, 11, 5);
    await typeGame(page, 4, 11, 8);
    await page.getByRole("button", { name: RESULT_SHEET.submit }).click();
    await expect(page.locator("[data-result-card]")).toContainText(/Waiting for .+ to confirm/);
    await page.close();
  });

  await test.step("the partner opens the mail's link and confirms", async () => {
    const [link] = await waitForMailMatch(partner.email, /https?:\/\/[^\s"'<>]+\/bookings\/[^\s"'<>]+\?result=confirm/);
    const page = await browser.newPage();
    await plantSession(page, partner.session);
    await page.goto(rehome(link, base));
    const sheet = page.getByRole("dialog", { name: CONFIRM_SHEET.title });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: CONFIRM_SHEET.confirm }).click();
    await expect(page.locator("[data-result-card]")).toContainText(RESULT_CARD.confirmed);
    await page.close();
  });

  await test.step("both see their badges under My game", async () => {
    for (const [who, badge] of [[organiser, "First win"], [partner, "On the record"]] as const) {
      const page = await browser.newPage();
      await plantSession(page, who.session);
      await page.goto("/profile");
      // The celebrations arrive after the page does — one at a time, a fresh member has several
      // (First court, On the record, maybe First win) — and while one is open the section behind
      // it is out of the accessibility tree. Dismissing each is part of the walk.
      const moment = page.getByRole("dialog", { name: /New badge|new badges/ });
      const section = page.getByRole("region", { name: MY_GAME.title });
      const earned = section.getByRole("button", { name: new RegExp(`^${badge}, Earned`) });
      await expect(async () => {
        if (await moment.isVisible()) await moment.getByRole("button", { name: CELEBRATION_COPY.keepPlaying }).click();
        await expect(moment).toBeHidden({ timeout: 2_000 });
        await expect(earned).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      await page.close();
    }
  });
});

test("a disputed result reaches the admin, who removes it", async ({ browser, request, baseURL }) => {
  // A couple of minutes normally. The headroom is for the two slow paths the walk still has:
  // the auth limiter's Retry-After (10 anonymous calls a minute, both viewports registering at
  // once) and a club with no court free until one frees up.
  test.setTimeout(1_200_000);
  const base = baseURL ?? "http://localhost:8088";
  const setup = await browser.newPage();
  const organiser = await newMember(setup, request, base, "Dispute Organiser");
  const partner = await newMember(setup, request, base, "Dispute Partner");
  await setup.close();
  const { bookingId, court, startsAt, endsAt } = await bookTogether(request, organiser, partner);
  await checkInThroughTheBox(request, court, bookingId, startsAt, endsAt);
  await untilStarted(startsAt);
  // Seconds normally, but a club with no free court waits for one — longer than an access token
  // lives (15 minutes). Signing both back in costs two per-account sign-ins.
  organiser.session = await passwordSession(request, organiser.email, organiser.password);
  partner.session = await passwordSession(request, partner.email, partner.password);

  const created = await request.post(`/api/v1/bookings/${bookingId}/result`, {
    headers: bearer(organiser.session),
    data: {
      idempotencyKey: `walk-${bookingId}`, format: "best_of_3",
      sideA: [`u:${organiser.session.userId}`], sideB: [`u:${partner.session.userId}`],
      games: [{ a: 11, b: 7 }, { a: 11, b: 9 }],
    },
  });
  const result = await ok<{ version: number }>(created, "record through the API");

  // The admin's desk lists every disputed result in the club — the other viewport's too, running
  // at once, and any an interrupted walk left behind — so the note names this booking.
  const note = `It went to a third game (${bookingId.slice(0, 8)}).`;
  const page = await browser.newPage();
  await plantSession(page, partner.session);
  await page.goto(`/bookings/${bookingId}`);
  await dismissCelebrations(page);
  await page.getByRole("button", { name: RESULT_CARD.somethingWrong }).click();
  const sheet = page.getByRole("dialog", { name: CONFIRM_SHEET.title });
  await sheet.getByLabel(CONFIRM_SHEET.noteLabel).fill(note);
  await sheet.getByRole("button", { name: CONFIRM_SHEET.send }).click();
  await expect(page.locator("[data-result-card]")).toContainText(RESULT_CARD.disputed);
  await page.close();
  expect(result.version).toBeGreaterThan(0);

  const admin = await devAdminSession(request);
  const desk = await browser.newPage();
  await plantSession(desk, admin);
  await desk.goto("/admin/results");
  await dismissCelebrations(desk);
  const row = desk.locator("[data-admin-result]").filter({ hasText: note });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: ADMIN_RESULTS.remove }).click();
  const dialog = desk.getByRole("dialog", { name: ADMIN_RESULTS.removeTitle });
  await dialog.getByLabel(ADMIN_RESULTS.reasonLabel).fill("Walk: both players agree it went to three");
  await dialog.getByRole("button", { name: ADMIN_RESULTS.remove }).click();
  await expect(row).toHaveCount(0);
  expect((await findMember(request, admin, partner.email))?.status).toMatch(/active/i);
  await desk.close();
});
