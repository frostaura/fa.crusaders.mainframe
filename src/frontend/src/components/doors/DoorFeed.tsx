import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "../Card";
import { DoorFeedRow } from "./DoorFeedRow";
import { ACTIVITY_READ_FAILED, activityEmptyNotice, isDoorScan } from "../../lib/deviceActivity";
import {
  DOOR_EVENTS_NOTE, OFFLINE_WHO_NOTE, doorEventRows, doorQuietNotice, doorScanCountHeading,
  doorScanCountLine,
} from "../../lib/doorsCopy";
import { clubDayAndClock } from "../../lib/clubClock";
import {
  DEVICE_ACTIVITY_LIMIT, type AdminDoorDevice, type DeviceActivityEntry, type DoorEventEntry,
  type DoorToday,
} from "../../lib/api";

/** The three states of one read, travelling together because they are one read. */
export type FeedRead = {
  entries: DeviceActivityEntry[] | null;
  /**
   * The non-scan events, where the API serves them separately. `undefined` means this API
   * does not send them yet and the feed derives its own from `entries` — see
   * {@link doorEventRows}. The page must be right against both backends.
   */
  events?: DoorEventEntry[] | null;
  loading: boolean;
  error: string | null;
};

/** The instant, and the club's own day — everything the quiet notice needs. */
export type FeedClock = { now: number; dayStartedAt: string; timezone: string };

/**
 * What the feed is showing right now, once its four states are collapsed into one read.
 *
 * <p>
 * <b>The failed read is checked BEFORE the empty one.</b> A failed read rendering "nothing
 * recorded for this door yet" would be making a claim about the DOOR — nobody has been
 * through it — out of a claim about the request, which is how an admin concludes a working
 * door is dead. `ActivityBody` already gets this right on Devices and the order is the whole
 * of why.
 * </p>
 *
 * <p>
 * <b>And the list is SCANS ONLY (B1).</b> The activity route answers every audit row that
 * carries this board's `device_id`, which includes admin edits, registrations, boots and
 * club-wide shuts. Mixed into the scans they were rendered as green "Refused" chips and
 * counted as refusals, so a door with thirteen edits and no scans reported "13 refused
 * scans, newest 1 min ago" while the club log and the CSV showed none for it. The scans
 * list, the club log, the CSV and the overview counters are four views of ONE set, and this
 * is where the front end holds up its end of that.
 * </p>
 */
/**
 * How many scans the feed opens with (B6).
 *
 * Ten answers "what just happened at this door", which is why somebody opened the page; the
 * rest is one press away. Fifty rows pushed the door's own controls 5 231 px down a phone.
 */
export const FEED_FIRST_PAGE = 10;

function FeedBody({ read, clock, expanded, onExpand, firstMoreRef }: {
  read: FeedRead;
  clock: FeedClock;
  expanded: boolean;
  onExpand: () => void;
  firstMoreRef: React.Ref<HTMLLIElement>;
}) {
  if (read.loading) return <p className="text-sm text-text-secondary">Loading…</p>;
  if (read.error) return <p className="text-sm text-danger-strong">{read.error || ACTIVITY_READ_FAILED}</p>;
  const scans = (read.entries ?? []).filter(isDoorScan);
  if (scans.length === 0) return <p className="text-sm text-text-secondary">{activityEmptyNotice(true)}</p>;
  /**
   * The newest SCAN, which is not `scans[0]`.
   *
   * The list is ordered, paged and counted on the DELIVERY axis, so an offline row that was
   * decided at 18:40 and uploaded at 21:05 sits above rows scanned at 20:00. Reading the
   * first row's `at` as "the newest scan" would tell a club its door had been quiet since
   * 18:40 on an evening it was busy — the quiet notice is precisely the sentence that must
   * not be computed off a sort key it does not share.
   */
  const newest = scans.reduce((max, row) => (row.at > max ? row.at : max), scans[0].at);
  const quiet = doorQuietNotice(newest, clock.dayStartedAt, clock.now, clock.timezone);
  // A3: said once, where the offline rows are. A reviewer read nine of them — some naming a
  // member, some not — with nothing on the page to reconcile the two. The list IS the
  // reconciliation: a code on it resolves to its holder, a code that is not resolves to
  // nothing at all.
  const anyOffline = scans.some((entry) => entry.offline);
  const shown = expanded ? scans : scans.slice(0, FEED_FIRST_PAGE);
  return (
    <>
      {quiet && <p role="status" className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-strong">{quiet}</p>}
      {anyOffline && <p className="text-xs text-text-muted">{OFFLINE_WHO_NOTE}</p>}
      <ul>
        {shown.map((entry, i) => (
          <DoorFeedRow
            key={`${entry.at}-${entry.action}-${i}`}
            entry={entry}
            now={clock.now}
            // A7 / O1: the CLUB's zone, from the same read the counts come from.
            timezone={clock.timezone}
            // C4: focus the first row this press revealed, so a keyboard user is not
            // returned to the top of a list that grew under them.
            innerRef={i === FEED_FIRST_PAGE ? firstMoreRef : undefined}
          />
        ))}
      </ul>
      {/* B6: the controls used to be BELOW all of this — 5 231 px down on a phone. Ten rows
          answers "what just happened at this door" and the rest is one press away. */}
      {!expanded && scans.length > FEED_FIRST_PAGE && (
        <button
          type="button"
          onClick={onExpand}
          className="min-h-11 w-full rounded-lg border border-control px-5 text-sm font-medium"
        >
          {`Show the other ${scans.length - FEED_FIRST_PAGE} scans`}
        </button>
      )}
      {/* Only when the read came back FULL. "Showing the 50 most recent" over four rows is
          a sentence that is not true, and the one it is standing in for — "there may be more
          than this" — is exactly what an admin needs to know only when there are.

          Counted against the RAW read, not against the scans left after filtering: the API's
          limit applies to rows, so a page of 50 rows that were mostly admin edits genuinely
          has more scans behind it even though few are on screen. */}
      {(read.entries?.length ?? 0) >= DEVICE_ACTIVITY_LIMIT && (
        <p className="text-xs text-text-muted">{`Showing the ${DEVICE_ACTIVITY_LIMIT} most recent.`}</p>
      )}
    </>
  );
}

/**
 * The things that happened TO this door, as opposed to the scans AT it.
 *
 * <p>
 * <b>Neutral, unchipped, and never counted (B1's ruling).</b> These are the rows that used
 * to be painted as refusals. They belong on the page — an admin diagnosing a door wants to
 * know somebody renamed it four minutes ago — but they are a different kind of fact from a
 * scan, and the heading is what says so. An action this build has never seen lands here too,
 * as "Unrecognised event" with its raw token, rather than being guessed at or dropped.
 * </p>
 */
function DoorEvents({ read, timezone }: { read: FeedRead; timezone: string }) {
  if (read.loading || read.error) return null;
  const rows = doorEventRows(read.entries, read.events);
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="door-events-heading" className="space-y-2">
      <h2 id="door-events-heading" className="text-lg font-semibold">Door events</h2>
      <Card className="space-y-2">
        <p className="text-sm text-text-secondary">{DOOR_EVENTS_NOTE}</p>
        <ul>
          {rows.map((row, i) => (
            <li key={`${row.at}-${i}`} className="border-t border-border py-2 first:border-t-0">
              <div className="flex flex-wrap items-baseline gap-2">
                {/* The raw token only on an UNRECOGNISED row: on a recognised one the
                    sentence already says what happened, and on an unrecognised one the token
                    is the only thing a reader can report upstream. Who did it is in the
                    sentence itself where the API says (WIRE-R2 §2's `actor_name`) — see
                    {@link doorEventRows}. */}
                <span className="min-w-0 break-words text-sm text-text-secondary">
                  {row.token ? `${row.text} · ${row.token}` : row.text}
                </span>
                {/* A7 / E-M5 / O1: the CLUB's zone, exactly as the scan rows above get.
                    This list was the one reading the VIEWER's clock, so an admin reading
                    from anywhere else saw the shut and the scans it explains dated
                    differently — and on a club five hours away, on different days. */}
                <time dateTime={row.at} className="ml-auto shrink-0 text-xs text-text-muted">
                  {clubDayAndClock(row.at, timezone)}
                </time>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

/**
 * One door's recent scans, open on arrival, with the day's own two numbers above them.
 *
 * <p>
 * <b>Not collapsed, unlike the panel on `/admin/devices`.</b> That one is shut by default
 * because a club with eight boards would make eight extra calls on a list page for panels
 * nobody opened. This page is one door and the feed is why it was opened.
 * </p>
 *
 * <p>
 * A18: the day totals are here as well as on the tile. An admin who has followed a link from
 * an email, or typed the URL, arrives on this page without having seen the overview, and
 * "how many people came through today" is the second question they have.
 * </p>
 */
export function DoorFeed({ door, today, read, clock }: {
  door: AdminDoorDevice;
  /** The server's own count for the club's day. Null when the counting failed — never a zero. */
  today: DoorToday | null;
  read: FeedRead;
  clock: FeedClock;
}) {
  const [expanded, setExpanded] = useState(false);
  const firstMoreRef = useRef<HTMLLIElement>(null);
  // C4: after the press, the first row it revealed takes focus.
  useEffect(() => { if (expanded) firstMoreRef.current?.focus(); }, [expanded]);
  return (
    // `min-w-0`: this is a grid item, and a grid item's default `min-width: auto` makes it
    // refuse to shrink below its content's min-content width. See the note on the grid in
    // `AdminDoorsDetail` — measured at 98 px of whole-page sideways scroll at 360 px with a
    // 32 px root font.
    <div className="min-w-0 space-y-6">
      <section aria-labelledby="door-feed-heading" className="space-y-2">
        <h2 id="door-feed-heading" className="text-lg font-semibold">Scans at this door</h2>
        <Card className="space-y-3">
          <div>
            <p className="text-xs text-text-muted">{doorScanCountHeading(clock.dayStartedAt, clock.timezone)}</p>
            <p className="text-sm text-text-secondary">{doorScanCountLine(today)}</p>
          </div>
          <FeedBody
            read={read}
            clock={clock}
            expanded={expanded}
            onExpand={() => setExpanded(true)}
            firstMoreRef={firstMoreRef}
          />
          <Link
            to={`/admin/doors/log?door=${encodeURIComponent(door.id)}`}
            className="inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-control px-5 text-sm font-medium"
          >
            All scans at this door
          </Link>
        </Card>
      </section>
      <DoorEvents read={read} timezone={clock.timezone} />
    </div>
  );
}
