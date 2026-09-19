import { Link } from "react-router-dom";
import { Card } from "../Card";
import { DoorFeedRow } from "./DoorFeedRow";
import { ACTIVITY_READ_FAILED, activityEmptyNotice } from "../../lib/deviceActivity";
import { doorQuietNotice } from "../../lib/doorsCopy";
import { DEVICE_ACTIVITY_LIMIT, type AdminDoorDevice, type DeviceActivityEntry } from "../../lib/api";

/** The three states of one read, travelling together because they are one read. */
export type FeedRead = {
  entries: DeviceActivityEntry[] | null;
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
 */
function FeedBody({ read, clock }: { read: FeedRead; clock: FeedClock }) {
  if (read.loading) return <p className="text-sm text-text-secondary">Loading…</p>;
  if (read.error) return <p className="text-sm text-danger-strong">{read.error || ACTIVITY_READ_FAILED}</p>;
  const entries = read.entries ?? [];
  if (entries.length === 0) return <p className="text-sm text-text-secondary">{activityEmptyNotice(true)}</p>;
  const quiet = doorQuietNotice(entries[0].at, clock.dayStartedAt, clock.now, clock.timezone);
  return (
    <>
      {quiet && <p role="status" className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-strong">{quiet}</p>}
      <ul>
        {entries.map((entry, i) => (
          <DoorFeedRow key={`${entry.at}-${entry.action}-${i}`} entry={entry} now={clock.now} />
        ))}
      </ul>
      <p className="text-xs text-text-muted">{`Showing the ${DEVICE_ACTIVITY_LIMIT} most recent.`}</p>
    </>
  );
}

/**
 * One door's recent scans, open on arrival.
 *
 * <p>
 * <b>Not collapsed, unlike the panel on `/admin/devices`.</b> That one is shut by default
 * because a club with eight boards would make eight extra calls on a list page for panels
 * nobody opened. This page is one door and the feed is why it was opened.
 * </p>
 */
export function DoorFeed({ door, read, clock }: {
  door: AdminDoorDevice;
  read: FeedRead;
  clock: FeedClock;
}) {
  return (
    <section aria-labelledby="door-feed-heading" className="space-y-2">
      <h2 id="door-feed-heading" className="text-lg font-semibold">Scans at this door</h2>
      <Card className="space-y-3">
        <FeedBody read={read} clock={clock} />
        <Link
          to={`/admin/doors/log?door=${encodeURIComponent(door.id)}`}
          className="inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-control px-5 text-sm font-medium"
        >
          All scans at this door
        </Link>
      </Card>
    </section>
  );
}
