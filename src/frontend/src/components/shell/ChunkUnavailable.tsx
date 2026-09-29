import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { WarningCircle, WifiSlash } from "@/components/ui/icons";
import { PageShell } from "@/components/ui/page-shell";
import { CHUNK_COPY } from "@/lib/shellCopy";
import { typography } from "@/lib/typography";

/**
 * A lazy page's code did not arrive. React caches a rejected `lazy()` for the life of the page, so
 * Retry is a reload — which, with signal, fetches the chunk; with none, lands back here. Signal
 * coming back does the same by itself.
 */
export function ChunkUnavailable({ offline: offlineAtFailure }: { offline: boolean }) {
  const [offline, setOffline] = useState(offlineAtFailure);
  useEffect(() => {
    const back = () => window.location.reload();
    const gone = () => setOffline(true);
    window.addEventListener("online", back);
    window.addEventListener("offline", gone);
    return () => {
      window.removeEventListener("online", back);
      window.removeEventListener("offline", gone);
    };
  }, []);
  const Icon = offline ? WifiSlash : WarningCircle;
  return (
    <PageShell width="narrow">
      <div role="alert" data-chunk-unavailable="" className="flex flex-col items-center gap-4 py-10 text-center">
        <Icon size={48} weight="duotone" aria-hidden="true" className="text-text-muted" />
        <h1 data-route-heading="" className={typography({ variant: "h1" })}>
          {offline ? CHUNK_COPY.offlineTitle : CHUNK_COPY.failedTitle}
        </h1>
        <p className="max-w-prose text-sm text-text-secondary">{offline ? CHUNK_COPY.offlineBody : CHUNK_COPY.failedBody}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => window.location.reload()}>{CHUNK_COPY.retry}</Button>
          <Button asChild variant="outline"><Link to="/my-code">{CHUNK_COPY.myCode}</Link></Button>
        </div>
      </div>
    </PageShell>
  );
}
