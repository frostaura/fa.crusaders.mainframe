import { Badge } from "../Button";
import { relative } from "../../lib/deviceLiveness";
import { doorOutcomeChip } from "../../lib/doorsCopy";
import { describeActivityReason, describeActivityWho } from "../../lib/deviceActivity";
import { formatInstant } from "../../lib/utils";
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
 * <b>An offline row is distinct three ways, because one is not enough:</b> a second
 * `[Offline]` chip, a 2 px left rule, and the existing "decided at the door" sentence. Its
 * `<time>` carries the SCAN's own time — the API resolves an offline row at the scan's time,
 * not at the upload's — and the title says so, so nobody reads it as the moment the club
 * heard about it.
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
  const who = describeActivityWho(entry);
  const why = describeActivityReason(entry);
  const detail = [doorName, why].filter((part) => part).join(" · ");
  const title = entry.offline
    ? `decided at the door at ${formatInstant(entry.at)}`
    : formatInstant(entry.at);
  return (
    <li
      ref={innerRef}
      tabIndex={innerRef ? -1 : undefined}
      className={`border-t border-border py-2 first:border-t-0 ${entry.offline ? "border-l-2 border-l-warning-strong pl-2" : ""}`}
    >
      <div className="flex flex-wrap items-baseline gap-2 sm:grid sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-3">
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={entry.action.startsWith("gate.denied") || entry.action === "device.unknown_scan" ? "warning" : "success"}>
            {doorOutcomeChip(entry)}
          </Badge>
          {entry.offline && <Badge tone="warning">Offline</Badge>}
        </span>
        <span className="min-w-0 break-words text-sm text-text-secondary">{who ?? ""}</span>
        <time dateTime={entry.at} title={title} className="ml-auto shrink-0 text-xs text-text-muted">
          {relative(entry.at, now)}
        </time>
      </div>
      {detail && <p className="mt-0.5 min-w-0 break-words text-sm text-text-secondary">{detail}</p>}
    </li>
  );
}
