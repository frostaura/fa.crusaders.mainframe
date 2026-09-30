import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import {
  EXPECTATION_WORD, courtAnnouncement, courtExpectation, expectationMeaning, healthLine,
  lightsLine, nextLine, startedLine, type CourtExpectation,
  duplicateBoxesWarning,
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
export function countdownFace(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    return `${hours}:${String(mins % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function CourtTile({ court, now, timezone, graceMinutes }: {
  court: ControlBoardCourt;
  /** One instant per paint, from the page's `useTicker`. Three tiles must not print two moments. */
  now: number;
  timezone: string | undefined;
  /** The club's grace window, for the DUE sentence, or null where the settings read failed. */
  graceMinutes: number | null;
}) {
  const state = courtExpectation(court);
  const left = secondsLeft(court.current?.ends_at, now);
  const lights = lightsLine(court.lights, timezone);
  const started = startedLine(court.current, court.lights, timezone);
  const boxLine = healthLine(court.device, now, "Box");
  const doorLine = healthLine(court.door, now, "Door");
  const bookedBy = court.current?.booked_by?.name ?? court.current?.label ?? null;
  const duplicate = duplicateBoxesWarning(court, now);

  return (
    <article
      // A real border (the card edge, same as every other card) so forced colours keep every
      // tile's edge — without one the tiles merge into one field of text at high contrast.
      className="flex flex-col gap-[calc(0.5rem*var(--board-scale,1))] rounded-xl border border-border bg-bg-surface p-[calc(1rem*var(--board-scale,1))] shadow-xs"
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
      <div className={cn("rounded-lg px-[calc(0.75rem*var(--board-scale,1))] py-[calc(0.5rem*var(--board-scale,1))]", TONE_BY_STATE[state])}>
        <p className="text-[calc(1.5rem*var(--board-scale,1))] font-bold leading-tight tracking-tight" aria-hidden>
          {EXPECTATION_WORD[state]}
        </p>
        {left !== null && (
          <p
            aria-hidden
            className="font-mono text-[calc(2.25rem*var(--board-scale,1))] font-bold leading-none tabular-nums"
          >
            {countdownFace(left)}
          </p>
        )}
        <StateSpeech
          text={courtAnnouncement(court.name, state, left === null ? null : Math.ceil(left / 60))}
          state={state}
        />
      </div>

      <p className="text-[calc(0.75rem*var(--board-scale,1))] text-text-secondary">
        {expectationMeaning(state, graceMinutes)}
      </p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[calc(0.875rem*var(--board-scale,1))]">
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
        <dt className="text-text-muted">Next</dt>
        <dd className="min-w-0 break-words text-text-primary">{nextLine(court.next, timezone).replace(/^Next /, "")}</dd>
      </dl>

      {/* The lights line is LAST and is prose, not a chip: it is a qualification, and a
          qualification rendered as a badge reads as a state. */}
      {lights && (
        <p className="text-[calc(0.75rem*var(--board-scale,1))] text-text-muted">{lights}</p>
      )}

      {/* R3 A-11: more than one box set to this court — said, never silently resolved. */}
      {duplicate && (
        <p data-duplicate-boxes="" className="rounded-lg border border-warning-strong bg-warning-soft px-[calc(0.75rem*var(--board-scale,1))] py-[calc(0.5rem*var(--board-scale,1))] text-[calc(0.75rem*var(--board-scale,1))] font-medium text-warning-strong">
          {duplicate}
        </p>
      )}

      {(boxLine || doorLine) && (
        <ul className="border-t border-border pt-[calc(0.5rem*var(--board-scale,1))] text-[calc(0.75rem*var(--board-scale,1))] text-text-muted">
          {boxLine && <li className="min-w-0 break-words">{boxLine}</li>}
          {doorLine && <li className="min-w-0 break-words">{doorLine}</li>}
        </ul>
      )}
    </article>
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
