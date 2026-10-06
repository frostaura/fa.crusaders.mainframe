import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ApiError, type ScheduleDay } from "./api";
import { UnsureOutcome } from "./bookingOutcome";
import { describeBookingError } from "./bookingErrors";
import { unsureSentence } from "./lostReply";
import { unsureWords } from "./lostReplyCopy";
import { PLAY_SETTINGS_UNSURE, playRefusal } from "./playCopy";
import { buyRefusal } from "./topUpShelf";
import { cancelFailedSentence } from "./topUpOpen";
import { CONFLICT_RETRY_CAUSE, describeFailure } from "./errors";
import { ADD_LOST } from "./groupsCopy";
import { useHoldLift } from "./scheduleEnd";

/**
 * R17 X17-1 / L17-5 — `503 conflict_retry` is an ANSWER: another change to the same thing landed at
 * that instant and this one gave way. Every write still re-reads (a batch may have landed items
 * first), but the sentence after the look said "The club's system didn't answer … try again in a
 * minute" — false on both counts. Each case is checked against an ordinary unanswered 503 too
 * (the fixture varied), which must keep its "didn't answer" words.
 */
const conflict = () => new ApiError(503, { error: "conflict_retry" });
const silent = () => new ApiError(503, {});

const NOT_SILENCE = /didn't answer|reply got lost|in a minute|in a moment/i;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("R17 X17-1 — booking sheets after the re-read", () => {
  for (const action of ["book", "cancel"] as const) {
    for (const checked of [true, false]) {
      it(`${action}, ${checked ? "checked" : "unread"}: says someone else was changing it`, () => {
        const said = describeBookingError(new UnsureOutcome(conflict(), checked), "fallback", { action });
        expect(said).toMatch(/^Someone else was changing that (court|booking) at the same moment/);
        expect(said).not.toMatch(NOT_SILENCE);
        if (checked) expect(said).toMatch(/Try again now\.$/);
        const quiet = describeBookingError(new UnsureOutcome(silent(), checked), "fallback", { action });
        expect(quiet).toMatch(/didn't answer/);
      });
    }
  }
});

describe("R17 X17-1 — every lost-reply pair built by unsureWords", () => {
  const words = unsureWords("the pause is as it was", "the pause changed", "My game");
  it("checked: the clash, what the record shows, try again now", () => {
    expect(unsureSentence(new UnsureOutcome(conflict(), true), words)).toBe(
      "Someone else was changing this at the same moment, so we checked: the pause is as it was — nothing changed. Try again now.");
    expect(unsureSentence(new UnsureOutcome(silent(), true), words)).toMatch(/^The club didn't answer/);
  });
  it("unread: the clash, and we can't tell", () => {
    expect(unsureSentence(new UnsureOutcome(conflict(), false), words)).toBe(
      "Someone else was changing this at the same moment and we couldn't check either, so we can't tell whether the pause changed. Refresh My game before trying again.");
  });
  it("a hand-written pair with no conflict words still never says the club didn't answer", () => {
    const said = unsureSentence(new UnsureOutcome(conflict(), true), { checked: "The club didn't answer.", unchecked: "x" });
    expect(said).toMatch(/^Someone else was changing/);
    expect(said).not.toMatch(NOT_SILENCE);
  });
  it("My game's switches (pause, celebrations) say it through playRefusal", () => {
    for (const w of [PLAY_SETTINGS_UNSURE.pause, PLAY_SETTINGS_UNSURE.celebrations]) {
      const said = playRefusal(new UnsureOutcome(conflict(), true), "pause your play", w);
      expect(said).toMatch(/^Someone else was changing this at the same moment, so we checked/);
      expect(said).not.toMatch(NOT_SILENCE);
    }
  });
  it("the desk's group add says it too", () => {
    expect(unsureSentence(new UnsureOutcome(conflict(), true), ADD_LOST.words("Juniors"))).toMatch(/^Someone else was changing this/);
    expect(unsureSentence(new UnsureOutcome(silent(), false), ADD_LOST.words("Juniors"))).toBe(
      "The club didn't answer and we couldn't check either, so we can't tell whether they were added to Juniors. Refresh the group before trying again.");
  });
});

describe("R17 X17-1 — the answer itself, before any look", () => {
  it("asks for another try now, not in a second or a minute", () => {
    expect(CONFLICT_RETRY_CAUSE).toMatch(/Try again now\.$/);
    expect(describeFailure(conflict(), { action: "save that" })).toMatch(/Try again now\.$/);
  });
});

describe("R17 X17-1 — buying and cancelling a purchase", () => {
  it("a conflict_retry on Continue is read back AND remembered as a clash", () => {
    expect(buyRefusal(conflict())).toEqual({ kind: "unknown", conflict: true });
    expect(buyRefusal(silent())).toEqual({ kind: "unknown", conflict: false });
  });
  it("a purchase cancel's read-back after a clash says so", () => {
    expect(cancelFailedSentence(new UnsureOutcome(conflict(), true))).toMatch(/^Someone else was changing this purchase/);
    expect(cancelFailedSentence(new UnsureOutcome(conflict(), false))).not.toMatch(NOT_SILENCE);
    expect(cancelFailedSentence(new UnsureOutcome(silent(), true))).toMatch(/reply got lost/);
  });
});

describe("R17 X17-1 — lifting a hold from the grid", () => {
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
    return said;
  }

  it("still there after a clash: someone else was changing it, try again now", async () => {
    const said = await lift(conflict(), holdDay(true));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^Someone else was changing that hold at the same moment/);
    expect(said[0]).not.toMatch(NOT_SILENCE);
  });
  it("unreadable after a clash: still the clash, never silence", async () => {
    const said = await lift(conflict(), null);
    expect(said[0]).toMatch(/^Someone else was changing that hold/);
  });
  it("a silent 503 keeps 'didn't answer'", async () => {
    const said = await lift(silent(), holdDay(true));
    expect(said[0]).toMatch(/didn't answer/);
  });
});
