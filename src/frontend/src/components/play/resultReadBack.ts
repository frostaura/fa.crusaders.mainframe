import { writeOrReadBack, type Landed } from "@/lib/lostReply";
import { playEndpoints, type GameScore, type MatchResult, type MyPlay } from "@/lib/playApi";

/**
 * R3 I-1 — every result write (record, edit, confirm, dispute, withdraw) whose reply was lost
 * reads the booking's result back and believes it. The reviewer's Record landed (201) behind a
 * lost reply and the sheet said "Couldn't record"; the card stayed on "No result yet".
 *
 * Each `landed` test names what THIS press would have left on the record — never just "a result
 * exists", which another player's record would satisfy.
 */
type ReadOff = (result: MatchResult | null) => MatchResult | null;

export function resultWrite(
  bookingId: string,
  write: () => Promise<MatchResult>,
  landed: ReadOff,
): Promise<Landed<MatchResult>> {
  return writeOrReadBack(write, async () => landed((await playEndpoints.bookingResult(bookingId)).result));
}

function sameGames(a: readonly GameScore[], b: readonly GameScore[]): boolean {
  return a.length === b.length && a.every((g, i) => g.a === b[i].a && g.b === b[i].b);
}

const when = (ok: boolean, r: MatchResult | null) => (ok ? r : null);

/** What each press leaves behind, read off the result as it now stands. */
export const landedAs = {
  /** A result that was not there before, recorded by this viewer. */
  recorded: (me: string | null, before: string | null): ReadOff => (r) =>
    when(Boolean(r && r.result_id !== before && (me === null || r.submitted_by.user_id === me)), r),
  /** The same result at a later version, carrying the games this edit sent. */
  edited: (was: MatchResult, games: readonly GameScore[]): ReadOff => (r) =>
    when(Boolean(r && r.result_id === was.result_id && r.version > was.version && sameGames(r.games, games)), r),
  confirmed: (was: MatchResult): ReadOff => (r) => when(Boolean(r && r.result_id === was.result_id && r.status === "confirmed"), r),
  disputed: (was: MatchResult, me: string | null): ReadOff => (r) =>
    when(Boolean(r && r.result_id === was.result_id && r.status === "disputed" && (me === null || r.disputed_by?.user_id === me)), r),
  /** Withdrawn, or no longer the booking's result at all. */
  withdrawn: (was: MatchResult): ReadOff => (r) => {
    if (!r || r.result_id !== was.result_id) return { ...was, status: "withdrawn" };
    return when(r.status === "withdrawn", r);
  },
};

/**
 * The member's own play settings (the pause, the celebrations switch, the monthly goal): a lost
 * reply is read back off `GET /me/play` — `pick` returns the answer when the setting now stands
 * as this press asked, or null when it does not.
 */
export function myPlayWrite<T>(write: () => Promise<T>, pick: (play: MyPlay) => T | null): Promise<Landed<T>> {
  return writeOrReadBack(write, async () => pick(await playEndpoints.myPlay()));
}
