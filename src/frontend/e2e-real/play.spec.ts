import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
// Renamed on import: it plants a token, it is not a React hook, and the hooks rule reads names.
import {
  adjustCredits, devAdminSession, findMember, approveMember, passwordSession, useSession as plantSession, type Session,
} from "./support/api";
import { avatarFile, uniqueEmail, uniqueMembershipNumber, walkPassword } from "./support/ids";
import { rehome, verificationLink, waitForMailMatch } from "./support/mailhog";
import { INBOX_HEADING, VERIFY_OK_HEADING } from "../src/lib/registrationCopy";
import { ADMIN_RESULTS, CONFIRM_SHEET, MY_GAME, RESULT_CARD, RESULT_SHEET } from "../src/lib/playCopy";

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
 */

type Member = { email: string; password: string; name: string; session: Session };

function bearer(session: Session): Record<string, string> {
  return { Authorization: `Bearer ${session.accessToken}` };
}

async function ok<T>(res: Awaited<ReturnType<APIRequestContext["get"]>>, what: string): Promise<T> {
  if (!res.ok()) throw new Error(`${what} failed: HTTP ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
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
  await page.getByRole("button", { name: /submit|apply|join/i }).click();
  await expect(page.getByRole("heading", { name: INBOX_HEADING })).toBeVisible();
  await page.goto(await verificationLink(email, baseURL));
  await expect(page.getByRole("heading", { name: VERIFY_OK_HEADING })).toBeVisible();
  const admin = await devAdminSession(request);
  await approveMember(request, admin, email);
  const session = await passwordSession(request, email, password);
  await adjustCredits(request, admin, session.userId, 400, "Play walk setup");
  return { email, password, name, session };
}

type Court = { courtId: string; courtNumber: number };

/** The first court, and a start on the current slice boundary — a booking for NOW. */
async function courtNow(request: APIRequestContext, member: Member): Promise<{ court: Court; startsAt: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const day = await ok<{ courts: Court[]; sliceMinutes?: number }>(
    await request.get(`/api/v1/schedule?date=${today}`, { headers: bearer(member.session) }), "schedule");
  const slice = (day.sliceMinutes ?? 15) * 60_000;
  const start = new Date(Math.floor(Date.now() / slice) * slice).toISOString();
  return { court: day.courts[0], startsAt: start };
}

/** The organiser books the court for now with the partner on it; the partner says yes. */
async function bookTogether(request: APIRequestContext, organiser: Member, partner: Member): Promise<{ bookingId: string; court: Court }> {
  const { court, startsAt } = await courtNow(request, organiser);
  const booked = await ok<{ booking_id: string; players?: { participants: { participant_id: string; user_id: string | null }[] } }>(
    await request.post("/api/v1/bookings/", {
      headers: bearer(organiser.session),
      data: { courtId: court.courtId, startsAt, sliceCount: 3, players: [{ userId: partner.session.userId }], splitMode: "equal" },
    }), "book with a partner");
  const seat = booked.players?.participants.find((p) => p.user_id === partner.session.userId);
  if (!seat) throw new Error("the partner's seat was not created");
  const detail = await ok<{ players: { participant_id: string; share_credits: number }[] }>(
    await request.get(`/api/v1/bookings/${booked.booking_id}`, { headers: bearer(partner.session) }), "partner reads the booking");
  const share = detail.players.find((p) => p.participant_id === seat.participant_id)?.share_credits ?? 0;
  await ok(await request.post(`/api/v1/bookings/${booked.booking_id}/players/${seat.participant_id}/accept`, {
    headers: bearer(partner.session), data: { expectedShareCredits: share },
  }), "partner accepts");
  return { bookingId: booked.booking_id, court };
}

/**
 * The box sees the session: a board heartbeats (registering itself), is given the booking's
 * court, heartbeats again for a roster, and activates the booking's code — exactly the path a
 * scan takes. This is what sets `bookings.CheckedInAt`; nothing else in the walk does.
 */
async function checkInThroughTheBox(request: APIRequestContext, court: Court, bookingId: string): Promise<void> {
  const admin = await devAdminSession(request);
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
  const entry = (hb.roster ?? []).map((line) => line.split("|")).find(([, relay]) => relay === "0");
  if (!entry) throw new Error(`no roster entry for the booking's court: ${JSON.stringify(hb.roster)}`);
  const act = await ok<{ activated: boolean; booking_id?: string }>(
    await box("/api/v1/device/activate", { method: "qr", token: entry[0], court: court.courtNumber }), "activate");
  expect(act).toMatchObject({ activated: true, booking_id: bookingId });
}

async function typeGame(page: Page, game: number, a: number, b: number) {
  await page.getByRole("textbox", { name: RESULT_SHEET.scoreFor(game, RESULT_SHEET.sideA) }).fill(String(a));
  await page.getByRole("textbox", { name: RESULT_SHEET.scoreFor(game, RESULT_SHEET.sideB) }).fill(String(b));
}

test.describe.configure({ mode: "serial" });

test("organiser records 3–1, partner confirms from the mail, both earn their badges", async ({ browser, request, baseURL }) => {
  test.setTimeout(240_000);
  const base = baseURL ?? "http://localhost:8088";
  const setup = await browser.newPage();
  const organiser = await newMember(setup, request, base, "Play Organiser");
  const partner = await newMember(setup, request, base, "Play Partner");
  await setup.close();

  const { bookingId, court } = await bookTogether(request, organiser, partner);
  await checkInThroughTheBox(request, court, bookingId);

  await test.step("the organiser records the match in the sheet", async () => {
    const page = await browser.newPage();
    await plantSession(page, organiser.session);
    await page.goto(`/bookings/${bookingId}`);
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
      // The celebration may be first; dismissing it is part of the walk.
      const moment = page.getByRole("dialog", { name: /New badge/ });
      if (await moment.isVisible().catch(() => false)) await moment.getByRole("button", { name: "Keep playing" }).click();
      const section = page.getByRole("region", { name: MY_GAME.title });
      await expect(section.getByRole("button", { name: new RegExp(`^${badge}, Earned`) })).toBeVisible();
      await page.close();
    }
  });
});

test("a disputed result reaches the admin, who removes it", async ({ browser, request, baseURL }) => {
  test.setTimeout(240_000);
  const base = baseURL ?? "http://localhost:8088";
  const setup = await browser.newPage();
  const organiser = await newMember(setup, request, base, "Dispute Organiser");
  const partner = await newMember(setup, request, base, "Dispute Partner");
  await setup.close();
  const { bookingId, court } = await bookTogether(request, organiser, partner);
  await checkInThroughTheBox(request, court, bookingId);

  const created = await request.post(`/api/v1/bookings/${bookingId}/result`, {
    headers: bearer(organiser.session),
    data: {
      idempotencyKey: `walk-${bookingId}`, format: "best_of_3",
      sideA: [`u:${organiser.session.userId}`], sideB: [`u:${partner.session.userId}`],
      games: [{ a: 11, b: 7 }, { a: 11, b: 9 }],
    },
  });
  const result = await ok<{ version: number }>(created, "record through the API");

  const page = await browser.newPage();
  await plantSession(page, partner.session);
  await page.goto(`/bookings/${bookingId}`);
  await page.getByRole("button", { name: RESULT_CARD.somethingWrong }).click();
  const sheet = page.getByRole("dialog", { name: CONFIRM_SHEET.title });
  await sheet.getByLabel(CONFIRM_SHEET.noteLabel).fill("It went to a third game.");
  await sheet.getByRole("button", { name: CONFIRM_SHEET.send }).click();
  await expect(page.locator("[data-result-card]")).toContainText(RESULT_CARD.disputed);
  await page.close();
  expect(result.version).toBeGreaterThan(0);

  const admin = await devAdminSession(request);
  const desk = await browser.newPage();
  await plantSession(desk, admin);
  await desk.goto("/admin/results");
  const row = desk.locator("[data-admin-result]").filter({ hasText: "It went to a third game." });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: ADMIN_RESULTS.remove }).click();
  const dialog = desk.getByRole("dialog", { name: ADMIN_RESULTS.removeTitle });
  await dialog.getByLabel(ADMIN_RESULTS.reasonLabel).fill("Walk: both players agree it went to three");
  await dialog.getByRole("button", { name: ADMIN_RESULTS.remove }).click();
  await expect(row).toHaveCount(0);
  expect((await findMember(request, admin, partner.email))?.status).toMatch(/active/i);
  await desk.close();
});
