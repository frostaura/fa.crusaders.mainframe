import { Badge } from "../Button";
import { relative } from "../../lib/deviceLiveness";
import { doorRowRender } from "../../lib/doorsCopy";
import { describeActivityWho } from "../../lib/deviceActivity";
import { clubInstant } from "../../lib/clubClock";
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
export function DoorFeedRow({ entry, now, doorName, innerRef }: {
  entry: DeviceActivityEntry;
  now: number;
  /** Set on the club log, where a row has to say which door it was. Absent on a door's own feed. */
  doorName?: string;
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
   * A4. "decided at the door at 21:25" beside "last heard from 21:00" reads as a
   * contradiction until the row says the two are different facts: an offline row is stamped
   * with the SCAN, and the club learned of it whenever the board next called in.
   */
  const title = entry.offline
    ? `Decided at the door at ${clubInstant(entry.at)}.`
      + (entry.delivered_at
        ? ` The club was told at ${clubInstant(entry.delivered_at)}.`
        : " The club was told when the door next called in.")
    : clubInstant(entry.at);
  return (
    <li
      ref={innerRef}
      tabIndex={innerRef ? -1 : undefined}
      className={`border-t border-border py-2 first:border-t-0 ${entry.offline ? "border-l-2 border-l-warning-strong pl-2" : ""}`}
    >
      <div className="flex flex-wrap items-baseline gap-2 sm:grid sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-3">
        <span className="flex flex-wrap items-center gap-1.5">
          {render.chip && <Badge tone={render.tone}>{render.chip}</Badge>}
          {entry.offline && <Badge tone="warning">Offline</Badge>}
        </span>
        <span className="min-w-0 break-words text-sm text-text-secondary">{who ?? ""}</span>
        <time dateTime={entry.at} title={title} className="ml-auto shrink-0 text-xs text-text-muted">
          {relative(entry.at, now)}
        </time>
      </div>
      {detail && <p className="mt-0.5 min-w-0 break-words text-sm text-text-secondary">{detail}</p>}
      {/* Said in the row, not only in a `title`: a tooltip is invisible on a phone and to a
          screen reader, and the "scan time vs delivery time" confusion is A4's whole finding. */}
      {entry.offline && (
        <p className="mt-0.5 text-xs text-text-muted">{title}</p>
      )}
    </li>
  );
}
