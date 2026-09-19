import { Link } from "react-router-dom";
import type { MemberDoor } from "../../lib/api";
import type { LastKnownDoor } from "../../lib/lastKnown";
import {
  OFFLINE_DETAILS_SUMMARY,
  STANDING_HEADING,
  STANDING_LOADING,
  type ReadFailure,
  describeStanding,
  offlineDetailsBody,
  standingFailed,
} from "../../lib/memberDoorCopy";

/**
 * "What opens the door for you right now" — the standing facts, below the QR.
 *
 * <p>
 * Below, because it is sofa content. A member at a door already knows what they want;
 * they want the QR and, if it failed, the reason. Above the QR this sentence would cost
 * the hero its place for something nobody at a door reads.
 * </p>
 *
 * <p>
 * It is the one block on this page that knows the club's POLICY — `/me/qr/generate` does
 * not carry one, which is why `describeDoor()` on the code card names the rule without
 * claiming to know it. That difference is the whole reason both exist, and why the code
 * card's clause is restored the moment this line is absent, stale or failed.
 * </p>
 */
export function StandingLine(props: {
  door: MemberDoor | null;
  cached: { value: LastKnownDoor; savedAt: string } | null;
  cachedMinutesAgo: number;
  loading: boolean;
  /**
   * Which failure the last read was, or null while it succeeded.
   *
   * <p>
   * It was a bare `failed` boolean, and the sentence it produced blamed the member's
   * phone for a 500 the club's own API had answered with. Who failed is the difference
   * between "move somewhere with signal" and "there is nothing on this phone to fix".
   * </p>
   */
  failure: ReadFailure | null;
}) {
  const { door, cached, cachedMinutesAgo, loading, failure } = props;

  if (door) {
    const line = describeStanding(door);
    return (
      <section className="space-y-2">
        <h2 className="text-sm font-medium">{STANDING_HEADING}</h2>
        <p className="text-sm text-text-secondary">{line.body}</p>
        {line.action?.kind === "book_a_court" && (
          <Link to="/schedule" className="inline-flex items-center min-h-11 text-sm text-accent-strong underline underline-offset-2 hover:no-underline">
            {line.action.label}
          </Link>
        )}
        <OfflineHalf rosterMaxEntries={door.roster_max_entries} />
      </section>
    );
  }

  // Loading before failed: the first load of a page opened in a corridor is not a failure
  // yet, and "can't check" is the wrong sentence to greet somebody with while a request
  // is still in flight. No skeleton — there are none anywhere in this product.
  if (loading && !failure) {
    return (
      <section className="space-y-2">
        <h2 className="text-sm font-medium">{STANDING_HEADING}</h2>
        <p className="text-sm text-text-muted">{STANDING_LOADING}</p>
      </section>
    );
  }

  const cachedLine = cached ? describeStanding(cached.value) : null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">
        {STANDING_HEADING} — <span className="text-text-muted">can't check</span>
      </h2>
      <p className="text-sm text-text-secondary">
        {standingFailed(
          cachedLine ? { body: cachedLine.body, minutesAgo: cachedMinutesAgo } : null,
          // A read that has neither succeeded nor failed cannot reach this arm, but the
          // type allows it; "network" is the safer of the two to assume, because it is the
          // one that offers the member something to do.
          failure ?? "network",
        )}
      </p>
      {cachedLine && <OfflineHalf rosterMaxEntries={cached?.value.roster_max_entries ?? null} />}
    </section>
  );
}

/**
 * P6's other half, once, behind a disclosure.
 *
 * <p>
 * Closed by default because it is not what a member at a door needs in the next fifteen
 * seconds — and present at all because a club's doors behave differently when they are
 * cut off, and a page that states only the reachable half is a page that lies on the
 * night it matters.
 * </p>
 */
function OfflineHalf({ rosterMaxEntries }: { rosterMaxEntries: number | null }) {
  return (
    <details className="text-sm">
      <summary className="inline-flex items-center min-h-11 cursor-pointer text-accent-strong">
        {OFFLINE_DETAILS_SUMMARY}
      </summary>
      <p className="mt-1 text-text-secondary">{offlineDetailsBody(rosterMaxEntries)}</p>
    </details>
  );
}
