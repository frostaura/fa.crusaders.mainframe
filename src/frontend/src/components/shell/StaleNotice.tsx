import { Alert } from "@/components/Alert";
import { phoneIsOffline } from "@/lib/api";
import { OFFLINE_COPY } from "@/lib/offline/offlineCopy";

/**
 * R4 wave B — "this is what the phone had, and when": said above a page drawn from the member's
 * kept reads (`lib/offline`) because the club could not be reached. Nothing when the page is live.
 *
 * <p>
 * Offline is said as offline ("You're offline") only when the phone itself says it has no network;
 * a club that did not answer is "Couldn't refresh". Either way the time is the club's last answer,
 * and the page under it still works for reading. `extra` is the page's own consequence (the grid's
 * "Booking needs a connection").
 * </p>
 */
export function StaleNotice({ stale, readAt, extra }: { stale: boolean; readAt: number | null; extra?: string }) {
  if (!stale || readAt === null) return null;
  const offline = phoneIsOffline();
  return (
    <Alert tone="warning" live="polite" data-stale-notice="">
      <strong className="font-semibold">{offline ? OFFLINE_COPY.staleTitle : OFFLINE_COPY.refreshFailedTitle}</strong>
      {` — ${offline ? OFFLINE_COPY.staleLine(readAt) : OFFLINE_COPY.refreshFailedLine(readAt)}`}
      {extra ? ` ${extra}` : ""}
    </Alert>
  );
}
