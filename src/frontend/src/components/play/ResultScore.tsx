import { Trophy } from "@/components/ui/icons";
import type { MatchResult, ResultPlayer, Side } from "@/lib/playApi";
import { RESULT_CARD, sideNames } from "@/lib/playCopy";
import { cn } from "@/lib/utils";

/**
 * A match as a squash scoreboard: one row per side — who played, each game's points, and the
 * games won — with the winning side marked by a trophy AND the word (colour is never the only
 * signal). A real table, so a screen reader can walk it by row and column.
 *
 * <p>
 * The one scoreboard the booking's card, the confirm sheet, the results history and the admin's
 * list all show, so a match reads the same everywhere it appears.
 * </p>
 */
type Scored = Pick<MatchResult, "sides" | "games" | "games_won" | "winner">;

export function ResultScore({ result, you }: { result: Scored; you?: string | null }) {
  return (
    <table data-result-score="" className="w-full border-collapse text-sm tabular-nums">
      <caption className="sr-only">{RESULT_CARD.title}</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">{RESULT_CARD.sideA}</th>
          {result.games.map((_, i) => <th key={i} scope="col">{`Game ${i + 1}`}</th>)}
          <th scope="col">Games</th>
        </tr>
      </thead>
      <tbody>
        <SideRow result={result} side="a" you={you} />
        <SideRow result={result} side="b" you={you} />
      </tbody>
    </table>
  );
}

function names(players: readonly ResultPlayer[], you: string | null | undefined): string {
  return sideNames(players.map((p) => ({ name: p.user_id && p.user_id === you ? `${p.name} (you)` : p.name })));
}

function SideRow({ result, side, you }: { result: Scored; side: Side; you?: string | null }) {
  const won = result.winner === side;
  return (
    <tr data-side={side} data-winner={won || undefined} className="border-b border-border last:border-0">
      <th scope="row" className={cn("py-2 pr-3 text-left font-normal text-text-secondary", won && "font-semibold text-text-primary")}>
        <span className="inline-flex min-w-0 items-start gap-1.5 break-words">
          {won ? <Trophy size={16} weight="fill" aria-hidden="true" className="mt-0.5 shrink-0 text-success-strong" /> : null}
          <span>{names(result.sides[side], you)}</span>
          {won ? <span className="sr-only"> (won)</span> : null}
        </span>
      </th>
      {result.games.map((game, i) => {
        const took = game[side] > game[side === "a" ? "b" : "a"];
        return (
          <td key={i} className={cn("w-8 px-1 py-2 text-center text-text-secondary", took && "font-semibold text-text-primary")}>
            {game[side]}
          </td>
        );
      })}
      <td className={cn("w-10 py-2 pl-2 text-right text-lg font-semibold", won ? "text-text-primary" : "text-text-secondary")}>
        {result.games_won[side]}
      </td>
    </tr>
  );
}
