import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { ApiError, type ScheduleDay } from "./api";
import { UnsureOutcome } from "./bookingOutcome";
import { describeBookingError } from "./bookingErrors";
import { useHoldLift } from "./scheduleEnd";
import { INVITE_UNSURE, PICKER, PLAYERS_UNSURE, DETAIL_ACTIONS } from "./playersCopy";
import { inviteRefusal } from "@/components/players/invites/inviteFacts";
import { linkUnsure } from "@/components/players/detail/shareLink";
import { cancelBookings } from "@/components/bookings/cancelFlow";
import type { GridBooking } from "@/components/bookings/types";
import { PlayerPicker } from "@/components/players/PlayerPicker";
import { DETAIL_PATH, PID, renderDetail, serve } from "@/components/players/__tests__/detailKit";
import { refuse, renderPage, signOut, stubFetch } from "@/test/harness";

/**
 * R19 X19-2 follow-through (FE19x's sweep, handed to FE19m) — a plain 500 on a write is the club's
 * system ANSWERING with an error. `unsureReasonOf` says so (b9c9ce29); these callers still picked
 * busy / conflict / silence by code and said "The club didn't answer … try again in a minute" over
 * a 500. Each is checked against a gateway silence (502/504) beside it, which keeps its words — and,
 * for the hold lift and the bulk rows, against `503 service_busy`, which said "didn't answer" too.
 */

const err500 = () => new ApiError(500, { error: "internal_error" });
const silent = () => new ApiError(504, {});
const busy = () => new ApiError(503, { error: "service_busy" });
const ERROR = /^The club's system hit an error/;
const SILENCE = /didn't answer/;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); });

describe("booking sheets (bookingErrors)", () => {
  for (const action of ["book", "cancel"] as const) {
    it(`${action}: an unread 500 is an error, a 504 is silence`, () => {
      const said = describeBookingError(err500(), "fallback", { action });
      expect(said).toMatch(ERROR);
      expect(said).not.toMatch(SILENCE);
      expect(describeBookingError(silent(), "fallback", { action })).toMatch(SILENCE);
    });
    for (const checked of [true, false]) {
      it(`${action}, ${checked ? "checked" : "unread"}: after a 500, an error — never "didn't answer"`, () => {
        const said = describeBookingError(new UnsureOutcome(err500(), checked), "fallback", { action });
        expect(said).toMatch(ERROR);
        expect(said).not.toMatch(SILENCE);
        expect(said).not.toMatch(/in a minute|in a moment/);
        expect(describeBookingError(new UnsureOutcome(silent(), checked), "fallback", { action })).toMatch(SILENCE);
      });
    }
  }
  it("several slots: the plural, for a 500 unread and read back", () => {
    for (const said of [
      describeBookingError(err500(), "fallback", { action: "book", slots: 2 }),
      describeBookingError(new UnsureOutcome(err500(), true), "fallback", { action: "book", slots: 2 }),
      describeBookingError(new UnsureOutcome(err500(), false), "fallback", { action: "book", slots: 2 }),
    ]) {
      expect(said).toMatch(ERROR);
      expect(said).toMatch(/these|slots/);
    }
  });
});

describe("lifting a hold (scheduleEnd)", () => {
  const holdDay = (present: boolean): ScheduleDay => ({
    date: "2030-09-09", timezone: "Africa/Johannesburg", sliceMinutes: 15, dayStartMinute: 360, dayEndMinute: 1320,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: [],
    slots: present ? [{ bookingId: "blk-1", courtId: "c1", startsAtUtc: "2030-09-09T16:00:00Z", endsAtUtc: "2030-09-09T16:15:00Z", status: "adminblock" }] : [],
  } as unknown as ScheduleDay);

  async function lift(error: ApiError, day: ScheduleDay | null) {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(error.payload), {
      status: error.status, headers: { "content-type": "application/json" },
    }))));
    const said: string[] = [];
    const toast = { push: (t: { text: string }) => { said.push(t.text); } };
    const { result } = renderHook(() => useHoldLift({ day: null, setDay: () => {}, reconcile: async () => day, toast }));
    await act(async () => { await result.current("blk-1", "Coaching"); });
    return said[0] ?? "";
  }

  for (const day of [true, false]) {
    it(`a 500, ${day ? "still there" : "day unreadable"}: an error`, async () => {
      const said = await lift(err500(), day ? holdDay(true) : null);
      expect(said).toMatch(ERROR);
      expect(said).not.toMatch(SILENCE);
    });
    it(`busy, ${day ? "still there" : "day unreadable"}: too busy, never "didn't answer"`, async () => {
      const said = await lift(busy(), day ? holdDay(true) : null);
      expect(said).toMatch(/too busy/);
      expect(said).not.toMatch(SILENCE);
    });
  }
  it("a 504 keeps its silence", async () => {
    expect(await lift(silent(), holdDay(true))).toMatch(SILENCE);
  });
});

describe("bulk cancel rows (cancelFlow)", () => {
  const booking = (id: string): GridBooking => ({
    bookingId: id, courtId: "c1", courtName: "Court 1", startsAt: "2030-09-09T16:00:00Z", endsAt: "2030-09-09T16:30:00Z",
    whenLabel: "Mon 9 Sep, 18:00", mine: true, memberFirstName: null, memberPhotoUrl: null,
    checkedIn: false, amountChargedMinutes: 30, timezone: "Africa/Johannesburg",
  });
  const dayWith = (ids: string[]): ScheduleDay => ({
    date: "2030-09-09", timezone: "Africa/Johannesburg", sliceMinutes: 15, dayStartMinute: 360, dayEndMinute: 1320,
    advanceBookingDays: 14, penaltyPct: 30, penaltyWindowMinutes: 15, courts: [],
    slots: ids.map((bookingId) => ({ bookingId, courtId: "c1", startsAtUtc: "2030-09-09T16:00:00Z", endsAtUtc: "2030-09-09T16:30:00Z", status: "booked" })),
  } as unknown as ScheduleDay);
  function answer(byUrl: (url: string) => { status: number; body: object }) {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const { status, body } = byUrl(String(input));
      return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    }));
  }

  for (const reread of [true, false]) {
    it(`a member's own, in turn (${reread ? "still there" : "unread"}): 500 an error, busy busy, 504 silence`, async () => {
      answer((url) => (url.includes("b1") ? { status: 500, body: { error: "internal_error" } }
        : url.includes("b2") ? { status: 503, body: { error: "service_busy" } } : { status: 504, body: {} }));
      const run = await cancelBookings({
        bookings: [booking("b1"), booking("b2"), booking("b3")], isAdmin: false, waive: false, reason: "",
        idempotencyKey: "k", reread: async () => (reread ? dayWith(["b1", "b2", "b3"]) : null),
      });
      const detail = new Map(run.rows.map((r) => [r.key, r.detail ?? ""]));
      expect(detail.get("b1")).toMatch(ERROR);
      expect(detail.get("b2")).toMatch(/too busy/);
      expect(detail.get("b2")).not.toMatch(SILENCE);
      expect(detail.get("b3")).toMatch(SILENCE);
    });
  }
  it("the desk's bulk route, a 500: every row says the error", async () => {
    answer(() => ({ status: 500, body: { error: "internal_error" } }));
    const run = await cancelBookings({
      bookings: [{ ...booking("b1"), mine: false }, { ...booking("b2"), mine: false }], isAdmin: true, waive: false, reason: "Rain",
      idempotencyKey: "k", reread: async () => dayWith(["b1", "b2"]),
    });
    for (const r of run.rows) expect(r.detail).toMatch(ERROR);
  });
});

describe("players surfaces", () => {
  it("the accept: a 500 read back says the error in the invite's own words", () => {
    for (const checked of [true, false]) {
      const said = inviteRefusal(new UnsureOutcome(err500(), checked));
      expect(said).toBe(checked ? INVITE_UNSURE.error.checked : INVITE_UNSURE.error.unchecked);
      expect(said).toMatch(ERROR);
    }
    expect(inviteRefusal(new UnsureOutcome(silent(), true))).toBe(INVITE_UNSURE.checked);
  });

  it("a new share link: a 500 is the error, a 504 silence", () => {
    expect(linkUnsure(new UnsureOutcome(err500(), false))).toMatch(ERROR);
    expect(linkUnsure(new UnsureOutcome(silent(), false))).toBe(PLAYERS_UNSURE.link);
  });

  it("the star: a 500 and an unreadable look say the error", async () => {
    const SAM = { user_id: "sam", name: "Sam Petersen", photo_url: null };
    let reads = 0;
    stubFetch([
      { path: "/api/v1/me/partners/favourites", respond: () => { reads += 1; return reads === 1 ? { items: [SAM] } : refuse(504, { error: "gateway_timeout" }); } },
      { path: "/api/v1/me/partners/recent", body: { items: [] } },
      { method: "DELETE", path: "/api/v1/me/partners/favourites/sam", respond: () => refuse(500, { error: "internal_error" }) },
    ]);
    renderPage(<PlayerPicker onPick={() => undefined} excludeUserIds={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: PICKER.unstar(SAM.name) }, { timeout: 10_000 }));
    const said = await screen.findByText(ERROR, {}, { timeout: 10_000 });
    expect(said.textContent).toContain(SAM.name);
    expect(screen.queryByText(SILENCE)).toBeNull();
  });

  it("the reminder: a 500 says the error", async () => {
    serve({ extra: [{ method: "POST", path: `${DETAIL_PATH}/players/${PID.alex}/nudge`, status: 500, body: { error: "internal_error" } }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.nudgeFor("Alex") }, { timeout: 10_000 }));
    const notice = () => document.querySelector("[data-detail-notice]");
    await waitFor(() => expect(notice()).toHaveTextContent(ERROR), { timeout: 10_000 });
    expect(notice()).not.toHaveTextContent(SILENCE);
  });
});
