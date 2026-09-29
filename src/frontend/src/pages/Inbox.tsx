import { InboxList } from "@/components/inbox/InboxList";
import { useInbox, type InboxFeed } from "@/components/inbox/useInbox";
import { Button } from "@/components/ui/button";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { RefreshButton } from "@/components/ui/refresh-button";
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
  return (
    <PageShell width="narrow">
      <PageHeader
        title={COPY.title}
        description={COPY.description}
        actions={<RefreshButton onRefresh={feed.retry} loading={feed.loading} label={COPY.refresh} />}
      />
      <div className="flex flex-col gap-4">
        {feed.answered && feed.count > 0 ? <UnreadBar feed={feed} /> : null}
        <InboxList feed={feed} />
      </div>
    </PageShell>
  );
}

/**
 * "3 unread · Mark all read", above the list rather than in the header: beside the refresh
 * button it squeezed the page's own title into two lines on a phone.
 */
function UnreadBar({ feed }: { feed: InboxFeed }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm font-medium text-text-secondary" data-unread-line="">{inboxUnreadLine(feed.count)}</p>
      <Button variant="outline" size="sm" pending={feed.markAll.pending} onClick={() => void feed.markAll.run()}>
        {COPY.markAll}
      </Button>
    </div>
  );
}
