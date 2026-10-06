import { useId } from "react";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { amountProblemSentence } from "@/lib/amountCopy";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SPLIT_MODES, type SplitMode } from "@/lib/playersApi";
import { BOOK_SPLIT, PLAYERS_COPY } from "@/lib/playersCopy";
import { amountProblem, seatName, type DraftSeat } from "./playersDraft";
import { SplitTotals } from "./SplitTotals";
import type { SplitEditor } from "./usePlayersStep";

/**
 * The BookSheet's Split step (D11): Equal · Ratio · Amount, the figure each mode asks for per
 * seat, and the live totals bar under it. Shown only when somebody is asked for a share — a
 * court with guests alone goes straight to Confirm, because a guest pays nothing to split.
 */

/** <code>hidePayNow</code>: passed to the totals — a standing booking's change sheet (R2 F2-3). */
export function SplitStep({ players, hidePayNow = false }: { players: SplitEditor; hidePayNow?: boolean }) {
  const { draft } = players;
  const labelId = useId();
  const pick = (value: string) => {
    // A single ToggleGroup lets the pressed item be pressed off; a split always has a mode.
    if (value) players.setMode(value as SplitMode);
  };
  return (
    <>
      <div className="grid gap-2">
        <p id={labelId} className="text-sm font-semibold text-text-primary">{BOOK_SPLIT.modeLabel}</p>
        {/* A radio group in behaviour as well as in name (F1.18): the items were announced as
            radios, but an arrow only moved focus, so a reader heard "Ratio, not checked" and
            nothing changed. Focus now selects, as a radio's arrow does. */}
        <ToggleGroup
          type="single" variant="outline" value={draft.mode} onValueChange={pick}
          role="radiogroup" aria-labelledby={labelId}
          // R18 L18-3 — three across while each holds its word, else one under another: "Amount"
          // ran 7px past its third of a 320 / 200 % sheet. A rem minimum, so it is text size that decides.
          className="grid w-full grid-cols-[repeat(auto-fit,minmax(min(100%,5rem),1fr))]"
        >
          {SPLIT_MODES.map((mode) => (
            <ToggleGroupItem key={mode} value={mode} onFocus={() => { if (draft.mode !== mode) pick(mode); }}>
              {BOOK_SPLIT.modes[mode]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-sm text-text-secondary">{BOOK_SPLIT.modeHint[draft.mode]}</p>
      </div>
      {draft.mode === "equal" ? null : <SeatFigures players={players} />}
      <SplitTotals players={players} hidePayNow={hidePayNow} />
    </>
  );
}

/** The per-seat figure a Ratio or Amount split asks for. Guests are listed as playing free. */
function SeatFigures({ players }: { players: SplitEditor }) {
  const { draft } = players;
  const ratio = draft.mode === "ratio";
  return (
    <ul aria-label={BOOK_SPLIT.sharesLabel} className="grid gap-3 rounded-xl border border-border bg-bg-surface p-3 [container-type:inline-size]">
      <li>
        {ratio ? (
          <FigureField
            label={BOOK_SPLIT.weightLabel(PLAYERS_COPY.you)} name={PLAYERS_COPY.you}
            value={draft.organiserWeight} numeric onChange={players.setOrganiserWeight}
          />
        ) : (
          <FixedFigure name={PLAYERS_COPY.you} text={BOOK_SPLIT.theRest} />
        )}
      </li>
      {draft.seats.map((s) => (
        <li key={s.seat}><SeatFigure seat={s} players={players} /></li>
      ))}
    </ul>
  );
}

function SeatFigure({ seat, players }: { seat: DraftSeat; players: SplitEditor }) {
  const name = seatName(seat.player);
  if (seat.player.kind === "guest") return <FixedFigure name={name} text={BOOK_SPLIT.playsFree} />;
  if (players.draft.mode === "ratio") {
    return (
      <FigureField
        label={BOOK_SPLIT.weightLabel(name)} name={name} value={seat.weight} numeric
        onChange={(v) => players.setWeight(seat.seat, v)}
      />
    );
  }
  const problem = amountProblem(seat.amount);
  return (
    <FigureField
      label={BOOK_SPLIT.amountLabel(name)} name={name} value={seat.amount}
      error={problem ? amountProblemSentence(problem, "minutes") : undefined}
      onChange={(v) => players.setAmount(seat.seat, v)}
    />
  );
}

function FixedFigure({ name, text }: { name: string; text: string }) {
  return (
    <div className="flex min-h-touch flex-wrap items-center justify-between gap-x-3">
      <span className="min-w-0 break-words text-sm font-semibold text-text-primary">{name}</span>
      <span className="ml-auto text-sm text-text-secondary">{text}</span>
    </div>
  );
}

type FigureFieldProps = {
  label: string; name: string; value: string; numeric?: boolean; onChange: (value: string) => void;
  /** The shared amount parser's sentence for what was typed (lib/amount), under the field. */
  error?: string;
};

/**
 * R18 L18-3 — the input is sized in `ch` (a figure of up to six digits and its padding), not a rem
 * `w-24` that was 192 px at 200 % text and left the name "B." — and where the card is narrow for its
 * text (a rem container query) the name stands whole above its input instead of beside it.
 */
const FIGURE_INPUT = { width: "calc(7ch + 1.5rem)", maxWidth: "100%" } as const;

/** A name on the left, its figure on the right; the field's name is the full "Weight for Sam". */
function FigureField(props: FigureFieldProps) {
  const { label, name, value, numeric = false, onChange, error } = props;
  return (
    <Field
      invalid={Boolean(error)}
      className="grid grid-cols-[minmax(0,1fr)] items-center gap-x-3 gap-y-1 [@container(min-width:16rem)]:grid-cols-[minmax(0,1fr)_auto]"
    >
      <FieldLabel className="break-words font-semibold">{name}</FieldLabel>
      <Input
        aria-label={label}
        value={value}
        // Weights and shares are both whole numbers (P13: whole minutes only), so both get the digit pad.
        inputMode="numeric"
        autoComplete="off"
        maxLength={numeric ? 3 : 6}
        style={FIGURE_INPUT}
        className="text-right tabular-nums"
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? <FieldError className="col-span-full">{error}</FieldError> : null}
    </Field>
  );
}
