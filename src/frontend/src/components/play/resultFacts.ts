import type { MatchResult, ResultStatus, Side } from "@/lib/playApi";
import { RESULT_CARD, scoreLine, sideNames } from "@/lib/playCopy";

/**
 * Small facts read off a result, shared by the card, the history and the admin row — kept out
 * of the components so each is one tested function rather than three inline guesses.
 */

/** A status's badge tone. The word beside it always says the status too. */
export const STATUS_TONE: Record<ResultStatus, "info" | "success" | "warning" | "neutral"> = {
  pending: "info",
  confirmed: "success",
  disputed: "warning",
  voided: "neutral",
  withdrawn: "neutral",
};

/** Which side recorded the match — the side the submitter is on. */
export function submittingSide(result: Pick<MatchResult, "sides" | "submitted_by">): Side {
  const onA = result.sides.a.some((p) => p.user_id !== null && p.user_id === result.submitted_by.user_id);
  return onA ? "a" : "b";
}

/**
 * Who the result waits for: the other side's MEMBERS by name. A guest cannot confirm, so a side
 * of guests alone is "the other side" — and the result confirms itself when its time comes.
 */
export function confirmingNames(result: Pick<MatchResult, "sides" | "submitted_by">): string {
  const other: Side = submittingSide(result) === "a" ? "b" : "a";
  const members = result.sides[other].filter((p) => p.kind === "member");
  return members.length > 0 ? sideNames(members) : "the other side";
}

/** "You won 3–1" from the viewer's own side, or null for a viewer who was not in the lineup. */
export function outcomeLine(result: Pick<MatchResult, "viewer_side" | "viewer_outcome" | "games_won">): string | null {
  if (!result.viewer_side || !result.viewer_outcome) return null;
  const mine = result.games_won[result.viewer_side];
  const theirs = result.games_won[result.viewer_side === "a" ? "b" : "a"];
  const lead = result.viewer_outcome === "won" ? RESULT_CARD.youWon : RESULT_CARD.youLost;
  return `${lead} ${scoreLine(mine, theirs)}`;
}
