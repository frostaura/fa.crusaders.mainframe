import { Badge } from "../ui/badge";
import { chipTone } from "./chipTone";
import { relative } from "../../lib/deviceLiveness";
import { clubRowTime } from "../../lib/clubClock";
import {
  doorRowRender, doorScanTiming, doorScanTimingLong, doorTimeIsUncertain,
} from "../../lib/doorsCopy";
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
/**
 * How much of a door's name one log row prints (A-M10 / R3-22).
 *
 * Long enough that every real club name fits whole — "Front door", "Side gate", "Squash hall
 * north" — and short enough that the 64-character slug somebody pasted does not take the
 * reason off the line on all fifty rows.
 */
export const DOOR_NAME_ON_A_ROW = 28;

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
  /**
   * <b>A-M10 / R3-22 — a long door name rendered in full on every row.</b>
   *
   * A `gate_key` may be 64 characters of somebody's own naming scheme and a display name 128,
   * and the log repeats it on all fifty rows — so one door with a long name pushed the reason
   * off the visible line on every row of the page. Truncated for the eye, complete in the
   * `title` and in the accessible name, so nothing is actually hidden: the row's whole detail
   * clause is what the screen reader gets.
   */
  const shownDoorName = doorName && doorName.length > DOOR_NAME_ON_A_ROW
    ? `${doorName.slice(0, DOOR_NAME_ON_A_ROW - 1).trimEnd()}…`
    : doorName;
  const detail = [shownDoorName, render.detail].filter((part) => part).join(" · ");
  const detailFull = [doorName, render.detail].filter((part) => part).join(" · ");
  /**
   * A4. "decided at the door at 21:25" beside "last heard from 21:00" read as a
   * contradiction until the row said the two are different facts: an offline row is stamped
   * with the SCAN and is delivered when the board next calls in — and that upload IS
   * contact, which is why `last_seen_at` can be later than a scan it delivered.
   *
   * `delivered_at` is non-null on offline rows only, so a null row has one instant and the
   * copy reports one. It never invents a delay.
   */
  /**
   * <b>E8 / C-H4 / A-H1 / R3-17 — this row's own clock may be wrong, and it says so.</b>
   *
   * A board has no RTC. The server already wrote `device.event_time_clamped` about a drifted
   * one, and the row printed the two instants in an order that cannot have happened —
   * "decided at 19:48, the door told us at 19:22". WIRE-R3 §2 flags the row; the guard also
   * runs from the instants themselves so an older API cannot produce the impossible order
   * either.
   */
  const uncertain = doorTimeIsUncertain(entry);
  const title = doorScanTimingLong(entry.at, entry.delivered_at, timezone, uncertain);
  const timing = doorScanTiming(entry.at, entry.delivered_at, timezone, uncertain);
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
            <Badge tone={chipTone(render.tone)}>
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
          {/* R3-17: the approximation is marked ON the face, not only in a sentence below
              it — a reader scanning a column of times takes the column at face value, and
              the one row whose time is a guess has to look different in that column. */}
          <span aria-hidden="true" className="block text-sm tabular-nums text-text-secondary">
            {uncertain ? `~${face}` : face}
          </span>
          <span aria-hidden="true" className="block">{relative(entry.at, now)}</span>
        </time>
      </div>
      {detail && (
        <p
          className="mt-0.5 min-w-0 break-words text-sm text-text-secondary"
          // A-M10 / R3-22: the whole name, for a pointer.
          title={detail === detailFull ? undefined : detailFull}
        >
          <span className="sr-only">{doorName ? "Door and reason: " : "Reason: "}</span>
          {/*
            The full clause is rendered a SECOND time, visually hidden, only where the
            visible one was actually shortened. Unconditionally it would put every reason on
            the page twice in the accessibility tree — and in every `getByText` — for the
            sake of a truncation that had not happened.
          */}
          {detail === detailFull ? detail : (
            <>
              <span className="sr-only">{detailFull}</span>
              <span aria-hidden="true">{detail}</span>
            </>
          )}
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
