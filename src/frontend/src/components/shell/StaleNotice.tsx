import { Alert } from "@/components/Alert";
import { phoneIsOffline } from "@/lib/api";
import { OFFLINE_COPY } from "@/lib/offline/offlineCopy";

/**
 * R4 wave B — "this is what the phone had, and when": said above a page drawn from the member's
 * kept reads (`lib/offline`) because the club could not be reached. Nothing when the page is live.
 *
 * <p>
 * Offline is said as offline ("You're offline") only when the phone says it has no network; a read
 * that never reached the club otherwise is "Can't reach the club" (R15 X15-3); a club that answered
 * with a failure (a 5xx, a 429) is "Couldn't refresh". Either way the time is the club's last answer,
 * and the page under it still works for reading. `extra` is the page's own consequence (the grid's
 * "Booking needs a connection").
 * </p>
 */
const STALE_TITLE = { offline: OFFLINE_COPY.staleTitle, unreachable: OFFLINE_COPY.unreachableTitle, failed: OFFLINE_COPY.refreshFailedTitle };
const STALE_LINE = { offline: OFFLINE_COPY.staleLine, unreachable: OFFLINE_COPY.unreachableLine, failed: OFFLINE_COPY.refreshFailedLine };

export function StaleNotice(props: { stale: boolean; readAt: number | null; offline?: boolean; extra?: string }) {
  const { stale, readAt, extra } = props;
  if (!stale || readAt === null) return null;
  // R15 X15-3 — "You're offline" only when the phone says it has no network; a read that never
  // reached the club from a phone that has one is "Can't reach the club".
  const reach = phoneIsOffline() ? "offline" : props.offline === true ? "unreachable" : "failed";
  return (
    <Alert tone="warning" live="polite" data-stale-notice="">
      <strong className="font-semibold">{STALE_TITLE[reach]}</strong>
      {` — ${STALE_LINE[reach](readAt)}`}
      {extra ? ` ${extra}` : ""}
    </Alert>
  );
}
