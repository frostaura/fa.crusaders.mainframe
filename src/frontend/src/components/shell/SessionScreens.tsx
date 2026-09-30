import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Clock, WifiSlash } from "@/components/ui/icons";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ApiError } from "@/lib/api";
import { rateLimitedSentence } from "@/lib/errors";
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
  // V-10 — a 429 is the club ANSWERING, busy; saying "can't reach" blamed a connection that was fine.
  const busy = cause instanceof ApiError && cause.status === 429;
  const wait = busy ? Number(cause.detail("retry_after_seconds")) || null : null;
  return (
    <PageShell width="narrow">
      <Card>
        <CardContent className="flex flex-col items-start gap-3">
          {busy
            ? <Clock size={40} weight="duotone" aria-hidden="true" className="text-text-muted" />
            : <WifiSlash size={40} weight="duotone" aria-hidden="true" className="text-text-muted" />}
          <h1 data-route-heading="" className={typography({ variant: "h2" })}>
            {busy ? CONNECTION_COPY.busyTitle : CONNECTION_COPY.unreachableTitle}
          </h1>
          <p className="text-sm text-text-secondary">
            {busy ? `${rateLimitedSentence(wait)} ${CONNECTION_COPY.busyBody}` : CONNECTION_COPY.unreachableBody}
          </p>
          <Button className="mt-1" pending={retry.pending} onClick={() => { void retry.run(); }}>
            {CONNECTION_COPY.retry}
          </Button>
        </CardContent>
      </Card>
    </PageShell>
  );
}

/** What a lazily loaded route shows while its code arrives: the page's shape, never "Loading…". */
export function RouteSkeleton() {
  return (
    <PageShell aria-busy="true">
      <p role="status" className="sr-only">Opening the page…</p>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-48" />
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
