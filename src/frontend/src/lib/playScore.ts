import type { GameScore, MatchFormat, Side } from "./playApi";

/**
 * Squash scoring, as the result sheet checks it while a member types (P12, `play.md` §4).
 *
 * <p>
 * <b>The server's rule, to the reason.</b> Point-a-rally to 11 (PAR-11): first to 11, except that
 * at 10–all play goes on until one side leads by two. Best of 3 or best of 5, complete matches
 * only. `SquashScore.cs` is authoritative; this module exists so the sheet can say what is wrong
 * under the row as it is typed instead of after a round trip, and the shared corpus
 * (`src/contracts/play/squash-scores.json`) is read by both suites so the two cannot disagree —
 * a sheet that allowed 12–11 while the server refused it would teach members to distrust both.
 * </p>
 */

export type GameReason = "negative" | "too_high" | "tied" | "below_eleven" | "not_two_clear" | "overrun";

/** What the server calls each refusal of a whole match (§4.2), with its figures. */
export type MatchVerdict =
  | { ok: true; winner: Side; games_won: { a: number; b: number } }
  | { ok: false; error: "format_invalid" }
  | { ok: false; error: "score_invalid"; game_index: number; reason: GameReason }
  | { ok: false; error: "games_after_decided"; game_index: number }
  | { ok: false; error: "match_incomplete"; games_needed: number };

/** The sanity bound on one side's score. A real tie-break never approaches it. */
export const MAX_POINTS = 99;
export const GAME_POINT = 11;

/** Games a side needs to win the match, or null for a format this build does not know. */
export function gamesNeeded(format: string): number | null {
  if (format === "best_of_3") return 2;
  if (format === "best_of_5") return 3;
  return null;
}

/**
 * The first rule a game breaks, in the server's order (§4.1), or null for a finished game.
 * `w` is the higher score and `l` the lower.
 */
export function gameReason(game: GameScore): GameReason | null {
  const { a, b } = game;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return "negative";
  const w = Math.max(a, b);
  const l = Math.min(a, b);
  if (w > MAX_POINTS) return "too_high";
  if (a === b) return "tied";
  if (w < GAME_POINT) return "below_eleven";
  if (w - l < 2) return "not_two_clear";
  if (w !== GAME_POINT && w - l !== 2) return "overrun";
  return null;
}

/** Who won a finished game. Only meaningful when {@link gameReason} is null. */
export function gameWinner(game: GameScore): Side {
  return game.a > game.b ? "a" : "b";
}

/**
 * The whole match, as the server judges it (§4.2): the format first, then each game in order —
 * whether the match was already decided before it, then its score — then whether it ended.
 */
export function judgeMatch(format: string, games: readonly GameScore[]): MatchVerdict {
  const needed = gamesNeeded(format);
  if (needed === null) return { ok: false, error: "format_invalid" };
  const won = { a: 0, b: 0 };
  for (let i = 0; i < games.length; i += 1) {
    if (won.a >= needed || won.b >= needed) return { ok: false, error: "games_after_decided", game_index: i };
    const reason = gameReason(games[i]);
    if (reason) return { ok: false, error: "score_invalid", game_index: i, reason };
    won[gameWinner(games[i])] += 1;
  }
  if (won.a < needed && won.b < needed) return { ok: false, error: "match_incomplete", games_needed: needed };
  return { ok: true, winner: won.a >= needed ? "a" : "b", games_won: won };
}

/* ─────────────────────────────── the sheet's live view ─────────────────────────────── */

/** One row of the sheet as typed: either box may still be empty. */
export type DraftGame = { a: number | null; b: number | null };

/** A draft row's state: not both typed yet, a finished game, or a rule it breaks. */
export type RowState =
  | { kind: "empty" }
  | { kind: "partial" }
  | { kind: "won"; winner: Side }
  | { kind: "invalid"; reason: GameReason };

export function rowState(row: DraftGame): RowState {
  if (row.a === null && row.b === null) return { kind: "empty" };
  if (row.a === null || row.b === null) return { kind: "partial" };
  const reason = gameReason({ a: row.a, b: row.b });
  return reason ? { kind: "invalid", reason } : { kind: "won", winner: gameWinner({ a: row.a, b: row.b }) };
}

/** What the match looks like so far, from the rows the sheet shows. */
export type MatchProgress = {
  won: { a: number; b: number };
  needed: number;
  /** Either side has reached `needed`. */
  decided: boolean;
  /** How many rows the sheet should show: one per finished game, plus one open row until decided. */
  rows: number;
  /** The first row that breaks a rule, or null. */
  firstInvalid: number | null;
  /** Games still needed to finish, at the fewest: 0 once decided. */
  remaining: number;
};

/**
 * Walks the draft the way the sheet grows it: a finished game adds the next row, a decided
 * match drops any row after the deciding one. Rows after an invalid or unfinished row are not
 * counted, so a mistake in game 2 never lets game 3 decide the match.
 */
export function matchProgress(format: MatchFormat, rows: readonly DraftGame[]): MatchProgress {
  const needed = gamesNeeded(format) ?? 3;
  const won = { a: 0, b: 0 };
  let firstInvalid: number | null = null;
  let finished = 0;
  for (const row of rows) {
    if (won.a >= needed || won.b >= needed) break;
    const state = rowState(row);
    if (state.kind === "invalid" && firstInvalid === null) firstInvalid = finished;
    if (state.kind !== "won") break;
    won[state.winner] += 1;
    finished += 1;
  }
  const decided = won.a >= needed || won.b >= needed;
  const remaining = decided ? 0 : needed - Math.max(won.a, won.b);
  return { won, needed, decided, rows: decided ? finished : finished + 1, firstInvalid, remaining };
}

/**
 * The draft trimmed or grown to what {@link matchProgress} says the sheet shows — the one
 * function that owns "a row is added as the previous one completes and removed once the match is
 * decided". Rows are kept, never re-created, so a member's typing is not lost to a re-render.
 */
export function shapeRows(format: MatchFormat, rows: readonly DraftGame[]): DraftGame[] {
  const progress = matchProgress(format, rows);
  const most = progress.needed * 2 - 1;
  // Decided: exactly the games that decided it. Not yet: never fewer rows than the member has
  // typed into (a slip in game 2 must not throw game 3 away), never more than a match can hold.
  const wanted = progress.decided ? progress.rows : Math.min(most, Math.max(progress.rows, typedRows(rows)));
  const shaped = rows.slice(0, Math.max(1, wanted));
  while (shaped.length < wanted) shaped.push({ a: null, b: null });
  return shaped;
}

/** Rows up to and including the last one with anything typed in it. */
function typedRows(rows: readonly DraftGame[]): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].a !== null || rows[i].b !== null) return i + 1;
  }
  return 0;
}

/** The finished games, as the wire carries them — only when every shown row is a finished game. */
export function finishedGames(rows: readonly DraftGame[]): GameScore[] | null {
  const games: GameScore[] = [];
  for (const row of rows) {
    if (row.a === null || row.b === null) return null;
    games.push({ a: row.a, b: row.b });
  }
  return games;
}
