import type { Ref } from "react";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { Bell } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { StateBlock } from "@/components/ui/state-block";
import { OfflineNothingKept } from "@/lib/offline/OfflineNothingKept";
import { OFFLINE_COPY } from "@/lib/offline/offlineCopy";
import { ApiError } from "@/lib/api";
import { INBOX_COPY as COPY } from "@/lib/playersCopy";
import type { MemberNotification } from "@/lib/playersApi";
import { usePagedFocus } from "@/lib/usePagedFocus";
import { useTicker } from "@/lib/useTicker";
import { StillTrying } from "@/lib/offline/StillTrying";
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
/**
 * R4 form factor (SPEC 3.6) — beside a detail pane a row with a target opens it there: `pick` holds
 * the open notice and what a press does instead of navigating. Absent, rows navigate as ever.
 */
export type InboxPick = { id: string | null; onPick: (notice: MemberNotification) => void };

export function InboxList({ feed, listRef, pick }: { feed: InboxFeed; listRef?: Ref<HTMLOListElement>; pick?: InboxPick }) {
  // The "Today, 18:05" face turns into a date at midnight; a minute is fine enough.
  const now = useTicker(true, 60_000);
  // R12 X12-2 — the last page takes "Show more" away; the first notice it brought takes focus.
  const showMore = usePagedFocus("[data-inbox-list] > li", feed.more.run);
  // R6 X6-4 — offline with no list kept on this phone: said as offline, not as a failure.
  if (feed.error !== null && feed.offline) return <OfflineNothingKept line={OFFLINE_COPY.nothingKept.inbox} />;
  return (
    <>
      {/* R9 X9-6 — outside the aria-busy region, so the slow line is announced. */}
      {feed.loading ? <StillTrying /> : null}
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
          ref={listRef}
          // R4 X4-5 — where focus goes when "Mark all read" takes its own bar away.
          tabIndex={-1}
          aria-label={COPY.listLabel}
          data-inbox-list=""
          className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-bg-surface shadow-xs focus:outline-none"
        >
          {feed.items.map((n) => <InboxRow key={n.id} notice={n} now={now} feed={feed} pick={pick} />)}
        </ol>
        {feed.more.error ? (
          <Alert tone="danger">{isCursorExpired(feed.more.error) ? COPY.cursorExpired : COPY.showMoreFailed}</Alert>
        ) : null}
        {feed.cursor ? (
          <div className="flex justify-center">
            <Button variant="outline" pending={feed.more.pending} onClick={showMore}>{COPY.showMore}</Button>
          </div>
        ) : null}
      </StateBlock>
    </>
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
