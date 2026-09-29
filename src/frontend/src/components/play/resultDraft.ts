import type {
  BookingResultView, GameScore, MatchFormat, MatchResult, PlayerKey, ResultDraftBody, Side,
} from "@/lib/playApi";
import { lineupProblem, RESULT_SHEET } from "@/lib/playCopy";
import { finishedGames, judgeMatch, matchProgress, shapeRows, type DraftGame } from "@/lib/playScore";

/**
 * The result sheet's working copy (§9.2): the format, who is on which side, and the games as
 * typed — plus the one question the submit button asks of it, "ready, or why not".
 *
 * <p>
 * Pure, so the rules the sheet enforces can be tested without rendering a sheet: the lineup is
 * 1 v 1 or 2 v 2 with the submitter in it (§3.2), and the games are a complete PAR-11 match
 * (§4) judged by the same `playScore` the corpus pins.
 * </p>
 */

export type Draft = {
  format: MatchFormat;
  /** Each candidate's side, or null when they sat this match out. */
  sides: Record<PlayerKey, Side | null>;
  rows: DraftGame[];
};

/** The sheet opened to record: the server's default sides and format, one open game. */
export function newDraft(view: BookingResultView): Draft {
  const sides: Record<PlayerKey, Side | null> = {};
  for (const candidate of view.candidates) sides[candidate.player_key] = null;
  for (const key of view.default_sides.a) sides[key] = "a";
  for (const key of view.default_sides.b) sides[key] = "b";
  return { format: view.default_format, sides, rows: shapeRows(view.default_format, []) };
}

/** The sheet opened to edit a pending result: its own lineup, format and games. */
export function draftFrom(view: BookingResultView, result: MatchResult): Draft {
  const sides: Record<PlayerKey, Side | null> = {};
  for (const candidate of view.candidates) sides[candidate.player_key] = null;
  for (const p of result.sides.a) sides[p.player_key] = "a";
  for (const p of result.sides.b) sides[p.player_key] = "b";
  const rows = result.games.map((g) => ({ a: g.a, b: g.b }));
  return { format: result.format, sides, rows: shapeRows(result.format, rows) };
}

export function withFormat(draft: Draft, format: MatchFormat): Draft {
  return { ...draft, format, rows: shapeRows(format, draft.rows) };
}

export function withSide(draft: Draft, key: PlayerKey, side: Side | null): Draft {
  return { ...draft, sides: { ...draft.sides, [key]: side } };
}

/** Every player to the other side — and every game's score with them, so the match still reads true. */
export function swapped(draft: Draft): Draft {
  const sides: Record<PlayerKey, Side | null> = {};
  for (const [key, side] of Object.entries(draft.sides)) sides[key] = side === "a" ? "b" : side === "b" ? "a" : null;
  return { ...draft, sides, rows: draft.rows.map((r) => ({ a: r.b, b: r.a })) };
}

/** One box of one game. `null` is an emptied box. */
export function withScore(draft: Draft, index: number, side: Side, value: number | null): Draft {
  const rows = draft.rows.map((r, i) => (i === index ? { ...r, [side]: value } : r));
  return { ...draft, rows: shapeRows(draft.format, rows) };
}

export function keysOn(draft: Draft, side: Side): PlayerKey[] {
  return Object.entries(draft.sides).filter(([, s]) => s === side).map(([key]) => key);
}

export type Readiness = { ready: true; body: ResultDraftBody } | { ready: false; problem: string };

/**
 * Whether the draft can be sent, and if not, the one sentence that says why — stated beside the
 * submit so a grey button is never the only answer (§9.2: "disabled with the reason stated").
 */
export function readiness(draft: Draft, viewerKey: PlayerKey | null): Readiness {
  const sideA = keysOn(draft, "a");
  const sideB = keysOn(draft, "b");
  const viewerIn = viewerKey !== null && (sideA.includes(viewerKey) || sideB.includes(viewerKey));
  const lineup = lineupProblem(sideA.length, sideB.length, viewerIn);
  if (lineup) return { ready: false, problem: lineup };
  const progress = matchProgress(draft.format, draft.rows);
  if (progress.firstInvalid !== null) return { ready: false, problem: RESULT_SHEET.fixGame(progress.firstInvalid + 1) };
  const games = finishedGames(draft.rows);
  if (!games || !judgeMatch(draft.format, games).ok) return { ready: false, problem: RESULT_SHEET.needGames };
  return { ready: true, body: { format: draft.format, sideA, sideB, games: games as GameScore[] } };
}

/** A fresh key per sheet opening: a double tap replays, a second opening records anew. */
export function newIdempotencyKey(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return random.slice(0, 64);
}
