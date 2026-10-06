import { Alert } from "@/components/Alert";
import { phoneIsOffline } from "@/lib/api";
import { OFFLINE_COPY } from "./offlineCopy";

/**
 * R6 X6-4 — a page offline with nothing of it kept on this phone (it was never drawn here with
 * signal). Said as offline, in the stale notice's words, not as a failure: "the club's system
 * couldn't be reached. Check your connection" in red blamed nobody useful and said nothing of what
 * the member could expect. The page's read comes back by itself on the signal's return
 * (`useCachedRead` re-reads on `online`), and its header keeps its Refresh.
 *
 * R15 X15-3 — "You're offline" only when the phone says so (`navigator.onLine === false`). A read
 * that never reached the club from a phone with a network is "Can't reach the club", and the
 * line's "once you're back online" becomes "Try again in a moment" — no `online` event will come.
 */
export function OfflineNothingKept({ line }: { line: string }) {
  const offline = phoneIsOffline();
  return (
    <Alert tone="warning" live="polite" data-offline-nothing-kept="">
      <strong className="font-semibold">{offline ? OFFLINE_COPY.staleTitle : OFFLINE_COPY.unreachableTitle}</strong>
      {/* R17 X17-6 — the line is a sentence of its own ("Your invites haven't …"): a full stop, not a dash before a capital. */}
      {`. ${offline ? line : OFFLINE_COPY.unreachableNothingKept(line)}`}
    </Alert>
  );
}
