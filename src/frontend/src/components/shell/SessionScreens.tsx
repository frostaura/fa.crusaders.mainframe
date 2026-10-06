import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Clock, WifiSlash } from "@/components/ui/icons";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, errorCode } from "@/lib/api";
import { SERVICE_BUSY_CAUSE, rateLimitedSentence } from "@/lib/errors";
import { CONNECTION_COPY } from "@/lib/shellCopy";
import { typography } from "@/lib/typography";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { CrestMark } from "./Crest";

/**
 * The screen a member looks at while the app works out whether they are still signed in.
 *
 * <p>
 * It was once the literal word "Loading…" at 14px in a corner, unchanged for the full twenty
 * seconds of the request budget against a backend that accepts the connection and never answers.
 * Something moves from the first frame, and a second line arrives once the wait stops being
 * ordinary. Deliberately not a progress bar: nothing here knows how long the backend will take.
 * </p>
 */
export function BootSplash() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 4000);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <PageShell width="narrow" data-testid="boot-splash">
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        <CrestMark className="h-14 w-12" />
        {/* aria-live, because a screen-reader user gets nothing at all from a spinner. */}
        <div className="flex items-center gap-2" role="status" aria-live="polite">
          <Spinner className="size-5 text-accent-strong" />
          <p className="text-sm font-medium text-text-secondary">Connecting to the club…</p>
        </div>
        {slow ? (
          <p className="max-w-prose text-sm text-text-muted">
            This is taking longer than usual. We'll keep trying for a few more seconds.
          </p>
        ) : null}
      </div>
    </PageShell>
  );
}

/**
 * Shown while a stored session exists and the club cannot be reached to confirm it. The member
 * keeps their token throughout, so the moment the backend answers the app carries on where it was.
 *
 * <p>
 * The retry shows that it is working (R12): against a stalled backend the old button did nothing
 * observable for 25 seconds, so a member pressed it again, and again. It is `pending` — spinner,
 * `aria-busy`, still focusable — for exactly as long as the probe is in flight, and comes back
 * when the probe resolves whether or not it succeeded (on failure this screen stays mounted).
 * </p>
 */
export function ConnectionLost({ onRetry, cause }: { onRetry: () => void | Promise<void>; cause?: unknown }) {
  const retry = useAsyncAction(async () => { await onRetry(); });
  const phoneOffline = useOffline();
  // V-10 — a 429 is the club ANSWERING, busy; saying "can't reach" blamed a connection that was fine.
  // R19 X19-1.1 — so are the 503s that pass by themselves (`service_busy`, `conflict_retry`).
  const busy = busyAnswer(cause);
  // R14 X14-3 — the phone says it has no connection at all: that is the member's signal, not the
  // club, so it is said as offline. `onLine` true proves nothing (Wi-Fi without internet), so only
  // false switches it; `auth.tsx` re-checks by itself on the browser's `online` event.
  const offline = phoneOffline && !busy;
  const title = busy ? CONNECTION_COPY.busyTitle : offline ? CONNECTION_COPY.offlineTitle : CONNECTION_COPY.unreachableTitle;
  const body = busy ? `${busy} ${CONNECTION_COPY.busyBody}` : offline ? CONNECTION_COPY.offlineBody : CONNECTION_COPY.unreachableBody;
  return (
    <PageShell width="narrow">
      <Card>
        <CardContent className="flex flex-col items-start gap-3">
          {busy
            ? <Clock size={40} weight="duotone" aria-hidden="true" className="text-text-muted" />
            : <WifiSlash size={40} weight="duotone" aria-hidden="true" className="text-text-muted" />}
          <h1 data-route-heading="" className={typography({ variant: "h2" })}>{title}</h1>
          <p className="text-sm text-text-secondary">{body}</p>
          <Button className="mt-1" pending={retry.pending} onClick={() => { void retry.run(); }}>
            {CONNECTION_COPY.retry}
          </Button>
        </CardContent>
      </Card>
    </PageShell>
  );
}

/**
 * The sentence for a club that ANSWERED, busy — a 429 (its rate-limit sentence, with the wait it
 * gives) or a 503 `service_busy` / `conflict_retry` (R19 X19-1.1: a session check that lost a
 * clash is busy for a moment too; nothing about it is the member's to resolve) — or null.
 */
function busyAnswer(cause: unknown): string | null {
  if (!(cause instanceof ApiError)) return null;
  if (cause.status === 429) return rateLimitedSentence(Number(cause.detail("retry_after_seconds")) || null);
  const code = errorCode(cause);
  if (cause.status === 503 && (code === "service_busy" || code === "conflict_retry")) {
    return SERVICE_BUSY_CAUSE.charAt(0).toUpperCase() + SERVICE_BUSY_CAUSE.slice(1);
  }
  return null;
}

/** `navigator.onLine === false`, followed through the browser's online/offline events. */
function subscribeOnline(fn: () => void) {
  window.addEventListener("online", fn);
  window.addEventListener("offline", fn);
  return () => { window.removeEventListener("online", fn); window.removeEventListener("offline", fn); };
}
function useOffline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine === false, () => false);
}

/** What a lazily loaded route shows while its code arrives: the page's shape, never "Loading…". */
export function RouteSkeleton() {
  return (
    <PageShell aria-busy="true">
      <p role="status" className="sr-only">Opening the page…</p>
      <div className="flex flex-col gap-3">
        {/* R4: never wider than the page — `w-48` alone is 384px at 200 % text on a 390 phone. */}
        <Skeleton className="h-8 w-48 max-w-full" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="h-48" />
    </PageShell>
  );
}
