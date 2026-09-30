import { useId, useState } from "react";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { ArrowsClockwise, Minus, Plus } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { errorCode } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  MATCH_FORMATS, playEndpoints, type BookingResultView, type MatchFormat, type MatchResult, type ResultPlayer, type Side,
} from "@/lib/playApi";
import { UnsureOutcome } from "@/lib/lostReply";
import { FORMAT_LABEL, GAME_REASON, playRefusal, progressLine, RESULT_SHEET, RESULT_UNSURE } from "@/lib/playCopy";
import { MAX_POINTS, matchProgress, rowState, type DraftGame } from "@/lib/playScore";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { typography } from "@/lib/typography";
import { cn } from "@/lib/utils";
import { PlayerAvatar } from "./PlayerAvatar";
import { landedAs, resultWrite } from "./resultReadBack";
import {
  draftFrom, newDraft, newIdempotencyKey, readiness, swapped, withFormat, withScore, withSide, type Draft,
} from "./resultDraft";

/**
 * Recording (or editing) a match (§9.2): the format, who played on which side, and the games —
 * checked as they are typed by the same rules the server applies, so the member learns "12–11
 * isn't a finished game" under the row, not from a refusal after pressing the button.
 *
 * <p>
 * A `Dialog`, which is a bottom sheet below 640px and a centred card above it. <b>The submit says
 * why it cannot be pressed yet</b> — a grey button with no reason is a question the member cannot
 * answer — and a server refusal maps to the same sentences the live check uses.
 * </p>
 */
export type ResultSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: BookingResultView;
  /** Set to edit that pending result; absent to record a new one. */
  editing?: MatchResult | null;
  /** `proven` — the reply was lost and the result was read back (R3 I-1). */
  onDone: (result: MatchResult, proven: boolean) => void;
  /** The result changed under the sheet (someone else recorded, or edited) — re-read the card. */
  onStale: () => void;
};

export function ResultSheet(props: ResultSheetProps) {
  const { open, onOpenChange } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <SheetBody {...props} /> : null}
    </Dialog>
  );
}

const STALE = new Set(["result_exists", "result_changed", "result_not_pending"]);

function useSheet(props: ResultSheetProps) {
  const { view, editing, onDone, onStale } = props;
  const auth = useAuth();
  const viewerKey = auth.status === "authenticated" ? `u:${auth.userId}` : null;
  const [draft, setDraft] = useState<Draft>(() => (editing ? draftFrom(view, editing) : newDraft(view)));
  const [key] = useState(newIdempotencyKey);
  const ready = readiness(draft, viewerKey);
  const me = auth.status === "authenticated" ? auth.userId : null;
  const send = useAsyncAction(async () => {
    if (!ready.ready) throw new Error("not ready");
    const body = ready.body;
    if (editing) {
      return resultWrite(view.booking_id, () => playEndpoints.edit(view.booking_id, { ...body, expectedVersion: editing.version }),
        landedAs.edited(editing, body.games));
    }
    return resultWrite(view.booking_id, () => playEndpoints.record(view.booking_id, { ...body, idempotencyKey: key }),
      landedAs.recorded(me, view.result?.result_id ?? null));
  }, {
    success: (landed) => onDone(landed.value, landed.proven),
    // A lost reply that was read back and had not landed: the card is read again too.
    failure: (error) => { if (error instanceof UnsureOutcome || STALE.has(errorCode(error) ?? "")) onStale(); },
  });
  return { draft, setDraft, ready, send, viewerKey };
}

type Sheet = ReturnType<typeof useSheet>;

function SheetBody(props: ResultSheetProps) {
  const sheet = useSheet(props);
  const { draft, ready, send } = sheet;
  const progress = matchProgress(draft.format, draft.rows);
  const reasonId = useId();
  return (
    <DialogContent data-dialog="result-sheet">
      <DialogHeader>
        <DialogTitle>{props.editing ? RESULT_SHEET.editTitle : RESULT_SHEET.title}</DialogTitle>
        <DialogDescription>{RESULT_SHEET.description}</DialogDescription>
        <p data-match-progress="" aria-live="polite" className="text-sm font-semibold tabular-nums text-text-primary">
          {progressLine(progress)}
        </p>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-6">
        <FormatPicker format={draft.format} onChange={(f) => sheet.setDraft((d) => withFormat(d, f))} />
        <LineupPicker sheet={sheet} candidates={props.view.candidates} />
        <GameRows draft={draft} onScore={(i, side, value) => sheet.setDraft((d) => withScore(d, i, side, value))} />
        {send.error ? (
          <Alert tone="danger" live="assertive">
            {playRefusal(send.error, RESULT_SHEET.action, props.editing ? RESULT_UNSURE.edit : RESULT_UNSURE.record)}
          </Alert>
        ) : null}
      </DialogBody>
      <DialogFooter className="items-stretch sm:items-center">
        {/* DOM: dismiss, primary, reason — the footer reverses on a phone, so the reason reads
            right above the button it explains; from sm it moves to the far left. */}
        <Button variant="outline" onClick={() => props.onOpenChange(false)}>{RESULT_SHEET.cancel}</Button>
        <Button
          aria-describedby={ready.ready ? undefined : reasonId}
          disabled={!ready.ready}
          pending={send.pending}
          onClick={() => void send.run()}
        >
          {props.editing ? RESULT_SHEET.save : RESULT_SHEET.submit}
        </Button>
        {ready.ready ? null : (
          <p id={reasonId} data-submit-reason="" className="text-sm text-text-secondary sm:order-first sm:mr-auto sm:max-w-xs">{ready.problem}</p>
        )}
      </DialogFooter>
    </DialogContent>
  );
}

function FormatPicker({ format, onChange }: { format: MatchFormat; onChange: (format: MatchFormat) => void }) {
  const labelId = useId();
  return (
    <div className="grid gap-2">
      <p id={labelId} className="text-sm font-semibold text-text-primary">{RESULT_SHEET.formatLabel}</p>
      <ToggleGroup
        type="single" variant="outline" value={format} aria-labelledby={labelId} className="grid w-full grid-cols-2"
        onValueChange={(value) => { if (value) onChange(value as MatchFormat); }}
      >
        {MATCH_FORMATS.map((f) => <ToggleGroupItem key={f} value={f}>{FORMAT_LABEL[f]}</ToggleGroupItem>)}
      </ToggleGroup>
    </div>
  );
}

/* ─────────────────────────────── lineup ─────────────────────────────── */

const SIDE_CHOICES = ["a", "b", "out"] as const;

function LineupPicker({ sheet, candidates }: { sheet: Sheet; candidates: readonly ResultPlayer[] }) {
  const labelId = useId();
  return (
    <fieldset className="grid gap-2" aria-labelledby={labelId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p id={labelId} className="text-sm font-semibold text-text-primary">{RESULT_SHEET.sidesLabel}</p>
          <p className="text-sm text-text-secondary">{RESULT_SHEET.sidesHint}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => sheet.setDraft(swapped)} icon={<ArrowsClockwise aria-hidden="true" />}>
          {RESULT_SHEET.swap}
        </Button>
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
        {candidates.map((c) => (
          <CandidateRow key={c.player_key} candidate={c} sheet={sheet} />
        ))}
      </ul>
    </fieldset>
  );
}

function CandidateRow({ candidate, sheet }: { candidate: ResultPlayer; sheet: Sheet }) {
  const side = sheet.draft.sides[candidate.player_key] ?? null;
  const you = candidate.player_key === sheet.viewerKey;
  const nameId = useId();
  const pick = (value: string) => {
    if (!value) return;
    sheet.setDraft((d) => withSide(d, candidate.player_key, value === "out" ? null : (value as Side)));
  };
  return (
    <li data-candidate={candidate.player_key} className="flex flex-wrap items-center gap-3 px-3 py-2">
      <PlayerAvatar name={candidate.name} photo={candidate.photo_url} />
      <span id={nameId} className="min-w-0 flex-1 break-words text-sm font-medium text-text-primary">
        {candidate.name}
        {you ? <span className="text-text-secondary">{` · ${RESULT_SHEET.you}`}</span> : null}
        {candidate.kind === "guest" ? <span className="text-text-secondary">{` · ${RESULT_SHEET.guest}`}</span> : null}
      </span>
      <ToggleGroup type="single" variant="outline" size="sm" value={side ?? "out"} onValueChange={pick} aria-labelledby={nameId}>
        {SIDE_CHOICES.map((choice) => (
          <ToggleGroupItem key={choice} value={choice} className="text-xs">{sideWord(choice)}</ToggleGroupItem>
        ))}
      </ToggleGroup>
    </li>
  );
}

function sideWord(choice: (typeof SIDE_CHOICES)[number]): string {
  if (choice === "a") return RESULT_SHEET.sideA;
  if (choice === "b") return RESULT_SHEET.sideB;
  return RESULT_SHEET.notPlaying;
}

/* ─────────────────────────────── games ─────────────────────────────── */

type OnScore = (index: number, side: Side, value: number | null) => void;

function GameRows({ draft, onScore }: { draft: Draft; onScore: OnScore }) {
  const labelId = useId();
  return (
    <div className="grid gap-3" role="group" aria-labelledby={labelId}>
      <p id={labelId} className="text-sm font-semibold text-text-primary">{RESULT_SHEET.gamesLabel}</p>
      <ol className="flex flex-col gap-4">
        {draft.rows.map((row, i) => <GameRow key={i} index={i} row={row} onScore={onScore} />)}
      </ol>
    </div>
  );
}

function GameRow({ index, row, onScore }: { index: number; row: DraftGame; onScore: OnScore }) {
  const errorId = useId();
  const state = rowState(row);
  const invalid = state.kind === "invalid";
  return (
    <li data-game-row={index} className="grid gap-2">
      <p className={typography({ variant: "overline" })}>{RESULT_SHEET.gameLabel(index + 1)}</p>
      <div className="flex flex-wrap gap-4">
        <ScoreStepper index={index} side="a" value={row.a} invalid={invalid} errorId={errorId} onScore={onScore} />
        <ScoreStepper index={index} side="b" value={row.b} invalid={invalid} errorId={errorId} onScore={onScore} />
      </div>
      <p id={errorId} aria-live="polite" data-game-error={index} className="text-sm font-medium text-danger-strong empty:hidden">
        {invalid ? GAME_REASON[state.reason] : ""}
      </p>
    </li>
  );
}

type StepperProps = {
  index: number;
  side: Side;
  value: number | null;
  invalid: boolean;
  errorId: string;
  onScore: OnScore;
};

function parsePoints(text: string): number | null {
  const digits = text.replace(/\D/g, "").slice(0, 3);
  if (digits === "") return null;
  return Math.min(MAX_POINTS + 1, Number(digits));
}

/** − [ 11 ] + — 44px targets, a numeric keyboard on phones, the side's name on every part. */
function ScoreStepper(props: StepperProps) {
  const { index, side, value, invalid, errorId, onScore } = props;
  const sideName = side === "a" ? RESULT_SHEET.sideA : RESULT_SHEET.sideB;
  const label = RESULT_SHEET.scoreFor(index + 1, sideName);
  const step = (delta: number) => onScore(index, side, Math.max(0, Math.min(MAX_POINTS, (value ?? 0) + delta)));
  return (
    <div className="grid gap-1">
      <span aria-hidden="true" className="text-xs text-text-secondary">{sideName}</span>
      <div className="flex items-center gap-1">
        <IconButton label={`${label}: one fewer`} variant="outline" onClick={() => step(-1)} disabled={value === null || value <= 0}>
          <Minus aria-hidden="true" />
        </IconButton>
        <Input
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={errorId}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          value={value === null ? "" : String(value)}
          onChange={(e) => onScore(index, side, parsePoints(e.target.value))}
          className={cn("w-14 text-center text-lg font-semibold tabular-nums")}
        />
        <IconButton label={`${label}: one more`} variant="outline" onClick={() => step(1)}>
          <Plus aria-hidden="true" />
        </IconButton>
      </div>
    </div>
  );
}
