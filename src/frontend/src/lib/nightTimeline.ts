import type { TraceEvent } from "./adminApi";
import { minutesSpoken } from "./minutes";
import { ACCOUNT_EVENT_WORDS, UNKNOWN_ACCOUNT_EVENT } from "./nightCopy";

/**
 * A night, reduced to what a person can read: bursts collapsed, gaps drawn, times qualified.
 *
 * <p>
 * <b>Pure, total, and the only part of this surface worth mutating.</b> The page around it is
 * layout; the decisions that can be wrong are here — whether three scans in forty seconds are
 * one row or three, whether an hour of nothing is drawn or silently skipped, and whether a
 * time may be printed as if it were exact. Each has a boundary, and a boundary is a thing a
 * test can stand on.
 * </p>
 *
 * <p>
 * <b>The gap's wording is the design, not the copy.</b> "Nothing recorded" and "nothing
 * happened" are different claims, and this product can only ever make the first. A box that
 * was offline, a door whose rows have passed their ninety days, a scan that never uploaded —
 * all of them produce a gap, and none of them is evidence that a member was not there.
 * </p>
 */

/** Events closer together than this collapse into one row. `night_trace_burst_seconds`. */
export const BURST_SECONDS = 60;
/** A gap longer than this is drawn rather than closed up. `night_trace_gap_minutes`. */
export const GAP_MINUTES = 30;
/** Fewer than this many events in a window is not a burst — it is just two things happening. */
export const BURST_MIN_EVENTS = 3;

/** One row on the rail: an event, a burst of them, or the drawn absence between. */
export type TimelineRow =
  | { kind: "event"; at: string; event: TraceEvent }
  | { kind: "burst"; at: string; events: TraceEvent[] }
  | { kind: "gap"; from: string; to: string; minutes: number };

type Options = { burstSeconds?: number; gapMinutes?: number };

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * What makes two events "the same kind" for the purpose of collapsing them.
 *
 * <p>
 * The `kind` and the device, never the outcome. Three refused scans and a release at one door
 * in forty seconds is ONE story — somebody trying their code and eventually getting in — and
 * splitting it by outcome would put the interesting row (the one that worked) on its own
 * while hiding the two that explain it. The door is part of the key because two doors in one
 * minute is two stories.
 * </p>
 */
function burstKey(event: TraceEvent): string {
  // R9 E9-3: money is never folded. Three wallet rows in a minute became "3 in 1 minute" and hid
  // each row's amount, the balance it left and who moved it — the three facts a disputed charge
  // is settled on. A unique key per row puts every one on the rail.
  if (isMoney(event)) return `money:${event.source ?? ""}:${event.source_id ?? event.at}:${event.headline ?? ""}`;
  const family = (event.kind ?? "").split(".")[0];
  // R11 E11-4: a box's refusal names what the scan was trying to do; a lights scan, a walk-up and
  // a pay-for at one box are three stories, never "3 in 1 minute".
  const attempt = typeof event.detail?.attempt === "string" ? event.detail.attempt : "";
  return `${event.strand ?? ""}:${family}:${placeOf(event)}:${attempt}`;
}

/** A row about minutes: the wallet strand, a ledger row, or any row carrying an amount. */
function isMoney(event: TraceEvent): boolean {
  return event.strand === "wallet" || event.source === "ledger" || typeof event.amount_minutes === "number";
}

/**
 * Which door or box an event happened at. The trace never sends `device_code` (R4 contract
 * audit, it.fails): keyed on it alone, scans at two doors in one minute collapsed into ONE burst.
 * The door's name and the board's id ride in `detail`; the court is the last resort.
 */
function placeOf(event: TraceEvent): string {
  const detail = event.detail ?? {};
  const said = [event.device_code, detail.door_name, detail.device_id, event.court?.id]
    .find((v) => typeof v === "string" && v !== "");
  return (said as string | undefined) ?? "";
}

/**
 * Collapse, draw the gaps, and leave everything else alone.
 *
 * <p>
 * Input is the server's chronological array, oldest first — a night reads forwards, so the
 * output is in the same order and the page does not reverse it.
 * </p>
 *
 * <p>
 * <b>A burst never swallows a lone event.</b> Two scans forty seconds apart stay two rows:
 * the threshold is {@link BURST_MIN_EVENTS}, and a run that does not reach it is emitted
 * individually rather than as a "burst of 2", which would hide one event behind a disclosure
 * for no gain at all.
 * </p>
 */
export function buildTimeline(events: TraceEvent[], options: Options = {}): TimelineRow[] {
  const burstMs = (options.burstSeconds ?? BURST_SECONDS) * 1000;
  const gapMs = (options.gapMinutes ?? GAP_MINUTES) * 60_000;
  const rows: TimelineRow[] = [];
  let run: TraceEvent[] = [];

  /** Emit whatever has accumulated: a burst if it earned one, otherwise the events. */
  const flush = () => {
    if (run.length === 0) return;
    if (run.length >= BURST_MIN_EVENTS) {
      rows.push({ kind: "burst", at: run[0].at, events: run });
    } else {
      for (const event of run) rows.push({ kind: "event", at: event.at, event });
    }
    run = [];
  };

  for (const event of events) {
    const previous = run.at(-1);
    const continues = previous !== undefined
      && burstKey(previous) === burstKey(event)
      // `<=` rather than `<`: events exactly `burstSeconds` apart are inside the window, which
      // is what "within 60 seconds" means to the person who set the number.
      && ms(event.at) - ms(previous.at) <= burstMs;

    if (!continues) {
      // The gap is measured from the LAST event of whatever came before — including the last
      // event of a burst — so a burst that ran for two minutes does not make the quiet
      // afterwards look two minutes longer than it was.
      const lastAt = previous?.at ?? lastEmittedAt(rows);
      flush();
      if (lastAt !== null) {
        const quiet = ms(event.at) - ms(lastAt);
        if (quiet > gapMs) {
          rows.push({ kind: "gap", from: lastAt, to: event.at, minutes: Math.round(quiet / 60_000) });
        }
      }
    }
    run.push(event);
  }
  flush();
  return rows;
}

/** The instant of the last real event already emitted, ignoring drawn gaps. */
function lastEmittedAt(rows: TimelineRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.kind === "event") return row.at;
    if (row.kind === "burst") return row.events.at(-1)!.at;
  }
  return null;
}

/**
 * "1 hour 4 minutes" — a duration a person reads, not a number of minutes.
 *
 * Deliberately not "64 minutes": the question a gap answers is "did they leave", and an hour
 * is a different answer from an hour and four minutes only to somebody doing arithmetic. Said
 * in words (R9 X9-4): it sits inside a sentence, and "1h 04m" was read aloud as letters.
 */
export function durationInWords(minutes: number): string {
  return minutesSpoken(minutes);
}

/**
 * How many of each outcome a burst holds, in the order they happened.
 *
 * Used for the burst's own summary line — "refused, refused, lock released" — which is the
 * whole story of somebody at a door, and is worth more than "3 scans".
 */
export function burstOutcomes(events: TraceEvent[]): string[] {
  return events.map((event) => {
    const headline = (event.headline ?? "").trim();
    if (headline) return headline;
    // Never a raw code on a person's night (F3.6): the kind in words, or the neutral sentence.
    return event.kind && event.kind !== "unrecognised" ? event.kind.replace(/[._]/g, " ") : UNKNOWN_ACCOUNT_EVENT;
  });
}

/**
 * Whether ANY event in this night carries an approximate time.
 *
 * The page needs to know before it renders the rail, because the explanation of what `≈`
 * means belongs above the timeline once, not beside every row that has one.
 */
export function hasApproximateTimes(events: TraceEvent[]): boolean {
  return events.some((event) => event.approximate === true);
}

/** The raw action behind an `unrecognised` row — the server appends it in brackets. */
function rawActionOf(event: TraceEvent): string | null {
  const said = /\(([a-z0-9_.]+)\)\s*$/.exec(event.headline ?? "");
  return said ? said[1] : null;
}

/**
 * The night's events as a person reads them (F3.6): an `unrecognised` row gets words from
 * `ACCOUNT_EVENT_WORDS` or a neutral sentence — never its raw code — a row declared not to be
 * part of the night is dropped, and a row the server sent twice (same source, same id) shows once.
 */
export function readableEvents(events: TraceEvent[]): TraceEvent[] {
  const seen = new Set<string>();
  const out: TraceEvent[] = [];
  for (const event of events) {
    const identity = event.source && event.source_id ? `${event.source}:${event.source_id}` : null;
    if (identity) {
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    if (event.kind !== "unrecognised") { out.push(event); continue; }
    const raw = rawActionOf(event);
    const words = raw !== null && raw in ACCOUNT_EVENT_WORDS ? ACCOUNT_EVENT_WORDS[raw] : UNKNOWN_ACCOUNT_EVENT;
    if (words === null) continue;
    out.push({ ...event, headline: words });
  }
  return out;
}
