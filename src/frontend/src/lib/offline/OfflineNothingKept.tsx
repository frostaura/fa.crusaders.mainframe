import { Alert } from "@/components/Alert";
import { OFFLINE_COPY } from "./offlineCopy";

/**
 * R6 X6-4 — a page offline with nothing of it kept on this phone (it was never drawn here with
 * signal). Said as offline, in the stale notice's words, not as a failure: "the club's system
 * couldn't be reached. Check your connection" in red blamed nobody useful and said nothing of what
 * the member could expect. The page's read comes back by itself on the signal's return
 * (`useCachedRead` re-reads on `online`), and its header keeps its Refresh.
 */
export function OfflineNothingKept({ line }: { line: string }) {
  return (
    <Alert tone="warning" live="polite" data-offline-nothing-kept="">
      <strong className="font-semibold">{OFFLINE_COPY.staleTitle}</strong>
      {` — ${line}`}
    </Alert>
  );
}
