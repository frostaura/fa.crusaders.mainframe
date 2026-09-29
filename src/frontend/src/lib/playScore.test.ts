import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { GameScore } from "./playApi";
import { gameReason, judgeMatch, matchProgress, shapeRows, type DraftGame } from "./playScore";
import { GAME_REASON, progressLine } from "./playCopy";

/**
 * The phone against the shared squash corpus (`play.md` §4.3). `SquashScoreTests` reads the SAME
 * file, so the sheet's live validation and the server's refusal agree to the reason — never "the
 * app said it was fine and then the club refused it".
 */

type Vector = { id: number; format: string; games: GameScore[]; expected: Record<string, unknown> };

const CORPUS = resolve(__dirname, "../../../contracts/play/squash-scores.json");
const vectors = (JSON.parse(readFileSync(CORPUS, "utf8")) as { vectors: Vector[] }).vectors;

describe("the shared squash corpus", () => {
  it("has every vector the spec lists", () => {
    expect(vectors.map((v) => v.id)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
  });

  it.each(vectors.map((v) => [v.id, v] as const))("vector %i", (_id, vector) => {
    expect(judgeMatch(vector.format, vector.games)).toEqual(vector.expected);
  });
});

/** An independent oracle, written from the rule's prose rather than from the table. */
function oracle(a: number, b: number): string | null {
  if (a === b) return "tied";
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  if (hi < 11) return "below_eleven";
  // Legal finishes: 11–0 … 11–9, or past 10–all exactly two clear (12–10, 13–11, …).
  if (hi === 11 && lo <= 9) return null;
  if (lo >= 10 && hi - lo === 2) return null;
  return hi - lo < 2 ? "not_two_clear" : "overrun";
}

describe("every game from 0–0 to 30–30", () => {
  it("agrees with an independent oracle", () => {
    const disagreements: string[] = [];
    for (let a = 0; a <= 30; a += 1) {
      for (let b = 0; b <= 30; b += 1) {
        const ours = gameReason({ a, b });
        if (ours !== oracle(a, b)) disagreements.push(`${a}-${b}: ${ours} vs ${oracle(a, b)}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("has a sentence for every reason", () => {
    for (const reason of ["negative", "too_high", "tied", "below_eleven", "not_two_clear", "overrun"] as const) {
      expect(GAME_REASON[reason].length).toBeGreaterThan(10);
    }
  });
});

const row = (a: number | null, b: number | null): DraftGame => ({ a, b });

describe("the sheet's rows", () => {
  it("starts with one open row", () => {
    expect(shapeRows("best_of_5", [])).toEqual([row(null, null)]);
  });

  it("adds a row as the previous game completes", () => {
    expect(shapeRows("best_of_5", [row(11, 7)])).toEqual([row(11, 7), row(null, null)]);
  });

  it("removes rows once the match is decided", () => {
    const rows = [row(11, 7), row(11, 9), row(null, null)];
    expect(shapeRows("best_of_3", rows)).toEqual([row(11, 7), row(11, 9)]);
  });

  it("never throws away a game typed after a slip earlier on", () => {
    const rows = [row(11, 7), row(11, 10), row(11, 4)];
    expect(shapeRows("best_of_5", rows)).toEqual(rows);
  });

  it("says the running score in the header", () => {
    const progress = matchProgress("best_of_5", [row(11, 7), row(9, 11), row(11, 5)]);
    expect(progressLine(progress)).toBe("2–1 · one more game");
    expect(progressLine(matchProgress("best_of_5", []))).toBe("0–0 · at least 3 more games");
    expect(progressLine(matchProgress("best_of_3", [row(11, 7), row(11, 9)]))).toBe("2–0 · match complete");
  });

  it("names the first game that breaks a rule", () => {
    expect(matchProgress("best_of_5", [row(11, 7), row(12, 11)]).firstInvalid).toBe(1);
    expect(matchProgress("best_of_5", [row(11, 7), row(12, null)]).firstInvalid).toBeNull();
  });
});
