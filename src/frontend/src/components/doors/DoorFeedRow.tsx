import { Badge } from "../Button";
import { relative } from "../../lib/deviceLiveness";
import { clubRowTime } from "../../lib/clubClock";
import { doorRowRender, doorScanTiming, doorScanTimingLong } from "../../lib/doorsCopy";
import { describeActivityWho } from "../../lib/deviceActivity";
import { type DeviceActivityEntry } from "../../lib/api";

/**
 * One scan, reason first.
 *
 * <p>
 * <b>The chip is first because the outcome is what the reader came for.</b> A feed whose
 * first column is a name is a list of people; a feed whose first column is an outcome is a
 * list of decisions, which is what this is and all it may be.
 * </p>
 *
 * <p>
 * <b>Tone comes from {@link doorRowRender}, never from a test at this call site (B1 / A2 /
 * C4).</b> It used to read
 * <code>action.startsWith("gate.denied") || action === "device.unknown_scan" ? "warning" :
 * "success"</code> — a two-way test on a four-way fact — so every row that was not one of
 * those two came out <b>success-green and labelled "Refused"</b>, including an admin's own
 * `device.updated` edit. A row that is not a scan now wears no outcome chip at all, and a
 * refusal can no longer come out green from any input whatsoever.
 * </p>
 *
 * <p>
 * <b>An offline row is distinct three ways, because one is not enough:</b> a second
 * `[Offline]` chip, a 2 px left rule, and a sentence saying when the club actually heard
 * about it. Its `<time>` carries the SCAN's own time — the API resolves an offline row at
 * the scan's time, not at the upload's — and the title says so, so nobody reads it as the
 * moment the club heard (A4).
 * </p>
 */
export function DoorFeedRow({ entry, now, doorName, timezone, innerRef }: {
  entry: DeviceActivityEntry;
  now: number;
  /** Set on the club log, where a row has to say which door it was. Absent on a door's own feed. */
  doorName?: string;
  /**
   * The CLUB's zone, from whichever read produced this row (A7 / O1).
   *
   * Not optional in practice and optional in the type only so a caller that genuinely has no
   * read yet falls back to the browser's zone — which, for a volunteer standing in the club,
   * is the same zone. What is never done is to guess a named one.
   */
  timezone?: string;
  /**
   * The log's "load older" moves focus to the FIRST APPENDED row, so a keyboard user is not
   * returned to the top of a list that just grew. Only that one row is given a ref, and the
   * `tabIndex` comes with it so the row is focusable only while it is the focus target.
   */
  innerRef?: React.Ref<HTMLLIElement>;
}) {
  const render = doorRowRender(entry);
  const who = describeActivityWho(entry);
  const detail = [doorName, render.detail].filter((part) => part).join(" · ");
  /**
   * A4. "decided at the door at 21:25" beside "last heard from 21:00" read as a
   * contradiction until the row said the two are different facts: an offline row is stamped
   * with the SCAN and is delivered when the board next calls in — and that upload IS
   * contact, which is why `last_seen_at` can be later than a scan it delivered.
   *
   * `delivered_at` is non-null on offline rows only, so a null row has one instant and the
   * copy reports one. It never invents a delay.
   */
  const title = doorScanTimingLong(entry.at, entry.delivered_at, timezone);
  const timing = doorScanTiming(entry.at, entry.delivered_at, timezone);
  /**
   * A7 / E-M5: the CLOCK FACE, visibly, with the day when the row is not today's.
   *
   * The row printed "6m ago" and kept the exact time in a `title` — invisible on a phone,
   * invisible to a screen reader, invisible to touch. "What time did that happen" is the
   * committee's question and the screen would not answer it. The relative age is still here,
   * second, because it is what makes the page feel live.
   */
  const face = clubRowTime(entry.at, now, timezone);
  return (
    <li
      ref={innerRef}
      tabIndex={innerRef ? -1 : undefined}
      className={`border-t border-border py-2 first:border-t-0 ${entry.offline ? "border-l-2 border-l-warning-strong pl-2" : ""}`}
    >
      {/*
        B17. The club log is a bare list whose columns are conveyed by VISUAL POSITION —
        which is nothing at all to somebody reading it with a screen reader, where four
        values arrive in a row with no indication of what each one is. A `<table>` was the
        other candidate and is wrong here: A2.3 forbids the sort control a table invites, and
        `DataTable`'s own `search` prop would put the member's name in a filter string, which
        is P3 broken by a component default. So the field names are carried as
        visually-hidden text on the list this surface already has.
      */}
      <div className="flex flex-wrap items-baseline gap-2 sm:grid sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-3">
        <span className="flex flex-wrap items-center gap-1.5">
          {render.chip && (
            <Badge tone={render.tone}>
              <span className="sr-only">Outcome: </span>{render.chip}
            </Badge>
          )}
          {entry.offline && <Badge tone="warning">Offline</Badge>}
        </span>
        <span className="min-w-0 break-words text-sm text-text-secondary">
          {who ? <><span className="sr-only">Whose code: </span>{who}</> : ""}
        </span>
        {/* A7: the clock face first and visibly; the relative age beneath it, quieter. The
            accessible name carries the long form so the fact still arrives once and
            completely — `aria-live="off"` because the age ticks and a row that rewrites
            itself every second interrupts the page somebody is reading. */}
        <time
          dateTime={entry.at}
          title={title}
          aria-label={`When: ${title}`}
          aria-live="off"
          className="ml-auto shrink-0 text-right text-xs text-text-muted"
        >
          <span aria-hidden="true" className="block text-sm tabular-nums text-text-secondary">{face}</span>
          <span aria-hidden="true" className="block">{relative(entry.at, now)}</span>
        </time>
      </div>
      {detail && (
        <p className="mt-0.5 min-w-0 break-words text-sm text-text-secondary">
          <span className="sr-only">{doorName ? "Door and reason: " : "Reason: "}</span>{detail}
        </p>
      )}
      {/* Said in the row, not only in a `title`: a tooltip is invisible on a phone and to a
          screen reader, and the "scan time vs delivery time" confusion is A4's whole finding.
          Rendered only where there ARE two instants — `delivered_at` is non-null on offline
          rows only, and a row with one instant must not be given a delay it did not have. */}
      {timing && <p className="mt-0.5 text-xs text-text-muted">{timing}</p>}
    </li>
  );
}
