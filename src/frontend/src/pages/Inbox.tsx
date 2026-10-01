import { useRef, useState } from "react";
import { InboxList } from "@/components/inbox/InboxList";
import { useInbox, type InboxFeed } from "@/components/inbox/useInbox";
import { Button } from "@/components/ui/button";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { RefreshButton } from "@/components/ui/refresh-button";
import { StaleNotice } from "@/components/shell/StaleNotice";
import { INBOX_COPY as COPY, inboxUnreadLine } from "@/lib/playersCopy";

/**
 * `/inbox` — the member's notifications (P11, D11): invites, shares that moved, reminders, lapsed
 * shares, games cancelled or changed, and partners' replies. The bell in the top bar opens it.
 *
 * <p>
 * "Mark all read" is offered only while something is unread, and is optimistic: the rows and the
 * bell clear at once and come back if the server refuses.
 * </p>
 */
export default function InboxPage() {
  const feed = useInbox();
  const list = useRef<HTMLOListElement>(null);
  const [said, setSaid] = useState("");
  // R4 X4-5 — the optimistic mark takes the bar (and the pressed button) away at once, which
  // dropped focus to <body> in silence. Focus goes to the list first; "All read" once it held.
  const markAll = async () => {
    setSaid("");
    list.current?.focus();
    const outcome = await feed.markAll.run();
    if (outcome.ok) setSaid(COPY.allRead);
  };
  return (
    <PageShell width="narrow">
      <PageHeader
        title={COPY.title}
        description={COPY.description}
        actions={<RefreshButton onRefresh={feed.retry} loading={feed.refreshing} label={COPY.refresh} />}
      />
      <div className="flex flex-col gap-4">
        <StaleNotice stale={feed.stale} readAt={feed.readAt} offline={feed.offline} />
        {feed.answered && feed.count > 0 ? <UnreadBar feed={feed} onMarkAll={markAll} /> : null}
        <p role="status" className="sr-only" data-inbox-said="">{said}</p>
        <InboxList feed={feed} listRef={list} />
      </div>
    </PageShell>
  );
}

/**
 * "3 unread · Mark all read", above the list rather than in the header: beside the refresh
 * button it squeezed the page's own title into two lines on a phone.
 */
function UnreadBar({ feed, onMarkAll }: { feed: InboxFeed; onMarkAll: () => Promise<void> }) {
  return (
    // R3 X-4 — at 200% text on a phone the label wraps inside its button (never past the page).
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="min-w-0 text-sm font-medium text-text-secondary" data-unread-line="">{inboxUnreadLine(feed.count)}</p>
      <Button
        variant="outline"
        size="sm"
        className="h-auto min-h-9 max-w-full whitespace-normal py-1.5"
        pending={feed.markAll.pending}
        onClick={() => void onMarkAll()}
      >
        {COPY.markAll}
      </Button>
    </div>
  );
}
