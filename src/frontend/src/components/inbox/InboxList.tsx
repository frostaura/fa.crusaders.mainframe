import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { Bell } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { StateBlock } from "@/components/ui/state-block";
import { ApiError } from "@/lib/api";
import { INBOX_COPY as COPY } from "@/lib/playersCopy";
import { useTicker } from "@/lib/useTicker";
import { InboxRow } from "./InboxRow";
import type { InboxFeed } from "./useInbox";

/**
 * The inbox's list (P11): newest first, with "Show more" for as long as the server has a cursor.
 *
 * <p>
 * <b>Three states, never two.</b> A skeleton shaped like the rows while the first page is out; a
 * failed read with a retry that says what it does NOT mean ("This doesn't mean you have none");
 * the empty sentence only for a read that ANSWERED with nothing. An older page that fails leaves
 * the rows above it standing and says so beside the button.
 * </p>
 */
export function InboxList({ feed }: { feed: InboxFeed }) {
  // The "Today, 18:05" face turns into a date at midnight; a minute is fine enough.
  const now = useTicker(true, 60_000);
  return (
    <StateBlock
      loading={feed.loading}
      error={feed.error}
      action={COPY.readAction}
      failedCaveat={COPY.readCaveat}
      onRetry={feed.retry}
      empty={feed.answered && feed.items.length === 0}
      emptyIcon={Bell}
      emptyTitle={COPY.empty}
      skeleton={<InboxSkeleton />}
    >
      <ol
        aria-label={COPY.listLabel}
        data-inbox-list=""
        className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-bg-surface shadow-xs"
      >
        {feed.items.map((n) => <InboxRow key={n.id} notice={n} now={now} feed={feed} />)}
      </ol>
      {feed.more.error ? (
        <Alert tone="danger">{isCursorExpired(feed.more.error) ? COPY.cursorExpired : COPY.showMoreFailed}</Alert>
      ) : null}
      {feed.cursor ? (
        <div className="flex justify-center">
          <Button variant="outline" pending={feed.more.pending} onClick={() => void feed.more.run()}>{COPY.showMore}</Button>
        </div>
      ) : null}
    </StateBlock>
  );
}

function isCursorExpired(error: unknown): boolean {
  return error instanceof ApiError && error.code === "cursor_invalid";
}

function InboxSkeleton() {
  return (
    <div data-inbox-skeleton="" className="flex flex-col divide-y divide-border rounded-xl border border-border" aria-hidden="true">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex items-start gap-3 px-4 py-3">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
