import { Button } from "@/components/ui/button";
import { OfflineNothingKept } from "@/lib/offline/OfflineNothingKept";

/**
 * R8 X7-3 / X8-2 — a page whose read could not reach the club, with nothing of it kept on this
 * phone: said as offline (FD2's `OfflineNothingKept`), never red "couldn't be reached" — and with
 * the failure's retry kept beside it. Offline is judged from the read itself, so this also shows on
 * Wi-Fi without internet, where no `online` event will ever bring the page back by itself.
 */
export function OfflineNothingKeptRetry({ line, onRetry, retryLabel = "Try again" }: { line: string; onRetry: () => void; retryLabel?: string }) {
  return (
    <div data-offline-retry="" className="grid justify-items-start gap-3">
      <OfflineNothingKept line={line} />
      <Button variant="outline" onClick={onRetry}>{retryLabel}</Button>
    </div>
  );
}
