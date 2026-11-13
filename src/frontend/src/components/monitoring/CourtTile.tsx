import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../ui/button";
import { CaretDown, CaretUp, Warning } from "../ui/icons";
import { cn } from "../../lib/utils";
import {
  COUNTDOWN_LABEL, EXPECTATION_WORD, LIGHTS_MISMATCH_WORDS, courtAnnouncement, courtExpectation, expectationMeaning,
  healthLine, lightsLine, lightsMismatch, lightsSecondsLeft, nextLine, startedLine, type CourtExpectation,
  DUPLICATE_BOXES_BOARDS, DUPLICATE_BOXES_HIDE, DUPLICATE_BOXES_OTHERS, DUPLICATE_BOXES_REVIEW, duplicateBoxesParts,
} from "../../lib/monitoringCopy";
import { type ControlBoardCourt } from "../../lib/adminApi";

/**
 * One court on the wall.
 *
 * <p>
 * <b>Everything about this component is "read it from across a room".</b> A club puts the
 * Control Board on a tablet by the desk; the person reading it is eight feet away, is a
 * volunteer, and is usually standing up holding something. So the state is a WORD in the
 * largest type on the tile after the court's name, the countdown is second, and the
 * qualifications are underneath in a size that rewards walking over.
 * </p>
 *
 * <p>
 * <b>Scale is one custom property, and only this component reads it.</b> `--board-scale` is 1
 * ordinarily and 1.6 in wall view. Every size inside is `calc(… * var(--board-scale))`, so
 * wall view is a single declaration on an ancestor rather than a second set of class strings
 * that drift from the first. Nothing outside this file consumes it.
 * </p>
 *
 * <p>
 * <b>The colour is never alone.</b> Under `forced-colors: active` the fills are discarded
 * entirely, so each tile carries a real `border border-border` card edge, which forced colours
 * repaint as a system edge — and the state is text, never a coloured pill.
 * </p>
 */

/**
 * Tone per expectation. Token classes only: no raw `slate-*`/`amber-*` on a new surface, and
 * every pair here is one `tokens.test.ts` already measures at 4.5:1 or better.
 *
 * `held` deliberately shares `info` with nothing else on the tile, and `unknown` is `warning`
 * rather than `danger`: a box that has gone quiet is a thing to look at, not a thing that has
 * gone wrong, and spending the danger tone on it is how an admin learns to ignore red.
 */
const TONE_BY_STATE: Record<CourtExpectation, string> = {
  lit: "bg-success-soft text-success-strong",
  due: "bg-info-soft text-info-strong",
  no_show: "bg-danger-soft text-danger-strong",
  free: "bg-bg-muted text-text-secondary",
  held: "bg-accent-soft text-accent-strong",
  unknown: "bg-warning-soft text-warning-strong",
};

/**
 * How long is left on the current booking, in whole seconds, or null.
 *
 * <p>
 * Recomputed from the clock on every tick and never accumulated: a counter that subtracts one
 * per tick drifts by exactly as much as the browser throttled it, which on a tab that has been
 * in the background for an hour is an hour. `useTicker` already suspends while the tab is
 * hidden and catches up on return, so the only correct arithmetic is "the end, minus now".
 * </p>
 */
function secondsLeft(endsAt: string | null | undefined, now: number): number | null {
  if (!endsAt) return null;
  const left = Math.round((new Date(endsAt).getTime() - now) / 1000);
  return left > 0 ? left : null;
}

/** "24:13" — always two digits, `tabular-nums` so the tile does not reflow as digits change. */
function countdownFace(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    return `${hours}:${String(mins % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function CourtTile({ court, now, timezone, graceMinutes, generatedAt }: {
  court: ControlBoardCourt;
  /** One instant per paint, from the page's `useTicker`. Three tiles must not print two moments. */
  now: number;
  timezone: string | undefined;
  /** The club's grace window, for the DUE sentence, or null where the settings read failed. */
  graceMinutes: number | null;
  /** When the server computed this view: what `lights.seconds_remaining` is relative to. */
  generatedAt?: string | null;
}) {
  const state = courtExpectation(court);
  // FA-8: while the lights are on, the big number is the LIGHTS' time left; the booking's end
  // is said apart from it when the two differ by more than a minute.
  const lightsLeft = lightsSecondsLeft(court.lights, now, generatedAt);
  const bookingLeft = secondsLeft(court.current?.ends_at, now);
  const left = lightsLeft ?? bookingLeft;
  const source = lightsLeft !== null ? "lights" : "booking";
  const bookingApart = lightsLeft !== null && bookingLeft !== null && Math.abs(lightsLeft - bookingLeft) > 60 ? bookingLeft : null;
  const mismatch = lightsMismatch(court, now, graceMinutes);
  const lights = lightsLine(court.lights, timezone);
  const started = startedLine(court.current, court.lights, timezone);
  const boxLine = healthLine(court.device, now, "Box");
  // No door line (R4 wave B): nothing maps a door to a court, and the server always sends
  // `door: null` — a line that can never appear is a line nobody can test.
  const bookedBy = court.current?.booked_by?.name ?? court.current?.label ?? null;
  const duplicate = duplicateBoxesParts(court, now);

  return (
    <article
      // A real border (the card edge, same as every other card) so forced colours keep every
      // tile's edge — without one the tiles merge into one field of text at high contrast.
      // R7 L7-2: a query container, so the Booked by / Next rows stack under a narrow (large-text) tile.
      className="@container/tile flex flex-col gap-[calc(0.5rem*var(--board-scale,1))] rounded-xl border border-border bg-bg-surface p-[calc(1rem*var(--board-scale,1))] shadow-xs"
      aria-labelledby={`court-${court.court_id}-name`}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-2">
        <h2
          id={`court-${court.court_id}-name`}
          className="min-w-0 break-words text-[calc(1rem*var(--board-scale,1))] font-semibold text-text-primary"
        >
          {court.name}
        </h2>
        {boxLine && (
          <span className="ml-auto shrink-0 text-[calc(0.75rem*var(--board-scale,1))] text-text-muted">
            {court.device?.link ? court.device.link.replace(/_/g, " ") : "unknown link"}
          </span>
        )}
      </div>

      {/*
        The state and the countdown, in one region, announced ONCE per state change.

        `aria-live` on the countdown would speak a number every second for the length of a
        squash match. The digits carry `aria-hidden`; what the region actually holds is the
        sentence below, written only when the state word changes — see {@link StateSpeech}.
      */}
      {/* R7 L7-2: the band is a size container and the word and the digits are capped by its width
          (cqi), so at 320 / 200 % "UNKNOWN" and "34:57" shrink to fit instead of running out of the
          band. The caps sit above the normal sizes everywhere else: they only bite on a narrow band. */}
      <div data-state-band="" className={cn("@container rounded-lg px-[calc(0.75rem*var(--board-scale,1))] py-[calc(0.5rem*var(--board-scale,1))]", TONE_BY_STATE[state])}>
        <p className="text-[length:min(calc(1.5rem*var(--board-scale,1)),18cqi)] font-bold leading-tight tracking-tight" aria-hidden>
          {EXPECTATION_WORD[state]}
        </p>
        {left !== null && (
          <p
            aria-hidden
            className="font-mono text-[length:min(calc(2.25rem*var(--board-scale,1)),22cqi)] font-bold leading-none tabular-nums"
          >
            {countdownFace(left)}
            <span className="ml-2 align-middle font-sans text-[length:min(calc(0.75rem*var(--board-scale,1)),8cqi)] font-medium" data-countdown={source}>
              {COUNTDOWN_LABEL[source]}
            </span>
          </p>
        )}
        <StateSpeech
          text={courtAnnouncement(court.name, state, left === null ? null : Math.ceil(left / 60))}
          state={state}
        />
      </div>

      {/* BA-04: lights burning on an empty court, or a checked-in court the box says is dark. */}
      {mismatch && (
        <p role="status" data-lights-mismatch={mismatch}
          className="flex items-start gap-2 rounded-lg bg-warning-soft px-2 py-1 text-[calc(0.8125rem*var(--board-scale,1))] font-medium text-warning-strong">
          <Warning aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{LIGHTS_MISMATCH_WORDS[mismatch]}</span>
        </p>
      )}

      <p className="text-[calc(0.75rem*var(--board-scale,1))] text-text-secondary">
        {expectationMeaning(state, graceMinutes)}
      </p>

      {/* R7 L7-2: the term beside its value only where the tile has room for both (a 14rem box —
          448px at 200 % text); under it, the value goes under its term and keeps its words whole. */}
      <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-[calc(0.875rem*var(--board-scale,1))] @[14rem]/tile:grid-cols-[auto_1fr]">
        {bookedBy && (
          <>
            <dt className="text-text-muted">Booked by</dt>
            <dd className="min-w-0 break-words text-text-primary">{bookedBy}</dd>
          </>
        )}
        {started && (
          <>
            <dt className="text-text-muted">Started</dt>
            <dd className="min-w-0 break-words text-text-primary">{started.replace(/^Started /, "")}</dd>
          </>
        )}
        {bookingApart !== null && (
          <>
            <dt className="text-text-muted">Booking ends in</dt>
            <dd className="min-w-0 break-words text-text-primary" data-booking-apart="">{countdownFace(bookingApart)}</dd>
          </>
        )}
        <dt className="text-text-muted">Next</dt>
        <dd className="min-w-0 break-words text-text-primary">{nextLine(court.next, timezone).replace(/^Next /, "")}</dd>
      </dl>

      {/* The lights line is LAST and is prose, not a chip: it is a qualification, and a
          qualification rendered as a badge reads as a state. */}
      {lights && (
        <p className="text-[calc(0.75rem*var(--board-scale,1))] text-text-muted">{lights}</p>
      )}

      {/* R3 A-11: more than one box set to this court — said, never silently resolved; folded to
          one line (R4 form factor, SPEC §3.11), because at 18 boxes the sentence was 30 lines. */}
      {duplicate && <DuplicateBoxes parts={duplicate} />}

      {boxLine && (
        <p className="mt-auto border-t border-border pt-[calc(0.5rem*var(--board-scale,1))] text-[calc(0.75rem*var(--board-scale,1))] text-text-muted min-w-0 break-words">
          {boxLine}
        </p>
      )}
    </article>
  );
}

/**
 * Several boxes set to one court, as ONE line — "18 boxes claim this court · Review" — that opens
 * which box the tile follows, every other box with when it was last heard, and what to do. A
 * disclosure, not a dialog: it opens in the tile, beside the court it is about.
 */
function DuplicateBoxes({ parts }: { parts: NonNullable<ReturnType<typeof duplicateBoxesParts>> }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div data-duplicate-boxes="" className="flex flex-col gap-2 rounded-lg border border-warning-strong bg-warning-soft px-[calc(0.75rem*var(--board-scale,1))] py-[calc(0.25rem*var(--board-scale,1))] text-[calc(0.75rem*var(--board-scale,1))] text-warning-strong">
      <div className="flex flex-wrap items-center gap-x-2">
        {/* R8 L6-16: the mark and the caret follow the box's text — rem, on the board's scale. */}
        <Warning size="calc(1rem*var(--board-scale,1))" weight="bold" aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 basis-32 font-semibold">{parts.summary}</span>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          // R8 L8-10: nowrap, it ran 49px past the warning box at 320 / 200 % text; it wraps instead.
          className="ml-auto max-w-full whitespace-normal text-warning-strong"
        >
          {open ? DUPLICATE_BOXES_HIDE : DUPLICATE_BOXES_REVIEW}
          {open
            ? <CaretUp size="calc(0.875rem*var(--board-scale,1))" weight="bold" aria-hidden="true" />
            : <CaretDown size="calc(0.875rem*var(--board-scale,1))" weight="bold" aria-hidden="true" />}
        </Button>
      </div>
      {/* `hidden` as a class, not the attribute: a utility's `display` beats the attribute's. */}
      <div id={id} className={open ? "flex flex-col gap-2 pb-2 text-text-primary" : "hidden"}>
        <p>{parts.follows}</p>
        {parts.others.length > 0 ? (
          <>
            <p className="font-semibold">{DUPLICATE_BOXES_OTHERS}</p>
            <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto [&_:focus-visible]:-outline-offset-2">
              {parts.others.map((line) => <li key={line} className="min-w-0 break-words">{line}</li>)}
            </ul>
          </>
        ) : null}
        <p>{parts.advice}</p>
        <Link to="/admin/monitoring/devices" className="self-start font-semibold text-accent-strong underline underline-offset-2">
          {DUPLICATE_BOXES_BOARDS}
        </Link>
      </div>
    </div>
  );
}

/**
 * The tile's one live region, written only when the STATE changes.
 *
 * <p>
 * A `role="status"` wrapped around the countdown announces on every mutation, which is once a
 * second, for ever, on four courts at once. What a person actually needs to hear is that Court
 * 2 has gone from DUE to SHOULD BE LIT. So the region holds a sentence and is rewritten only
 * when the state word moves; the minute count travels with it because it is free at that
 * moment, not because it is worth interrupting for on its own.
 * </p>
 *
 * <p>
 * Silent on the first paint, deliberately. Arriving at a page with four courts on it must not
 * read four announcements over the heading — the tiles are already on screen and a screen
 * reader will reach them.
 * </p>
 */
function StateSpeech({ text, state }: { text: string; state: CourtExpectation }) {
  const [spoken, setSpoken] = useState("");
  const last = useRef<CourtExpectation | null>(null);

  useEffect(() => {
    if (last.current === null) { last.current = state; return; }
    if (last.current === state) return;
    last.current = state;
    // No disable needed here, and it is worth saying why rather than leaving a directive that
    // does nothing: the two guards above return before this line on every render EXCEPT the
    // one where the state word actually changed, so the linter can see this is not a write on
    // every commit. A dead directive is worse than none — it reads as a rule being suppressed.
    setSpoken(text);
  }, [state, text]);

  return <span aria-live="polite" aria-atomic="true" className="sr-only">{spoken}</span>;
}
