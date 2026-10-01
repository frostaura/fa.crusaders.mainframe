import { useCallback, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { InboxList } from "@/components/inbox/InboxList";
import { useInbox, type InboxFeed } from "@/components/inbox/useInbox";
import { Button } from "@/components/ui/button";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Panel } from "@/components/ui/card";
import { Bell } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { SplitView } from "@/components/ui/split-view";
import { StateBlock } from "@/components/ui/state-block";
import { TextLink } from "@/components/ui/text-link";
import { useMediaQuery } from "@/components/ui/use-media-query";
import { appPath } from "@/components/inbox/notificationKinds";
import { InviteDetail } from "@/components/players/invites/InviteDetail";
import { useMyInvites } from "@/components/players/invites/useMyInvites";
import type { MemberNotification } from "@/lib/playersApi";
import { BookingDetailPanel } from "./BookingDetail";
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
  // R4 form factor (SPEC 3.6): from lg the list stands beside the notice's target, opened in place.
  const wide = useMediaQuery(LG_UP);
  const picked = usePickedNotice(feed.items);
  const listPane = (
    <div className="flex flex-col gap-4">
      <StaleNotice stale={feed.stale} readAt={feed.readAt} offline={feed.offline} />
      {feed.answered && feed.count > 0 ? <UnreadBar feed={feed} onMarkAll={markAll} /> : null}
      <p role="status" className="sr-only" data-inbox-said="">{said}</p>
      <InboxList feed={feed} listRef={list} pick={wide ? { id: picked.notice?.id ?? null, onPick: picked.pick } : undefined} />
    </div>
  );
  return (
    <PageShell width="wide">
      <PageHeader
        title={COPY.title}
        description={COPY.description}
        actions={<RefreshButton onRefresh={feed.retry} loading={feed.refreshing} label={COPY.refresh} />}
      />
      {wide ? (
        <SplitView
          listLabel={COPY.listLabel}
          listWidth="26rem"
          splitAt="56rem"
          list={listPane}
          detail={picked.notice ? <NoticeTarget key={picked.notice.id} notice={picked.notice} /> : null}
          placeholder={<StateBlock empty emptyIcon={Bell} emptyTitle={COPY.pickTitle} emptyHint={COPY.pickHint} />}
        />
      ) : listPane}
    </PageShell>
  );
}

const LG_UP = "(min-width: 1024px)";

/** The notice open in the pane: `?n=` — kept while the list re-reads around it. */
function usePickedNotice(items: MemberNotification[]) {
  const [params, setParams] = useSearchParams();
  const id = params.get("n");
  const notice = id ? items.find((n) => n.id === id) ?? null : null;
  const pick = useCallback((next: MemberNotification) => {
    setParams((was) => { const p = new URLSearchParams(was); p.set("n", next.id); return p; }, { replace: true });
  }, [setParams]);
  return { notice, pick };
}

const INVITE_PATH = /^\/invites\/([^/?#]+)/;

/**
 * A notice's target, in place (SPEC 3.6): an invite answered here; a share, a payment or a change
 * to a game as that booking's own panel; anything else as the notice with the way to it.
 */
function NoticeTarget({ notice }: { notice: MemberNotification }) {
  const path = appPath(notice.link);
  const seat = path?.match(INVITE_PATH)?.[1] ?? null;
  if (seat) return <InviteTarget seat={seat} notice={notice} />;
  if (notice.booking_id) return <BookingDetailPanel bookingId={notice.booking_id} />;
  return <NoticeCard notice={notice} />;
}

function InviteTarget({ seat, notice }: { seat: string; notice: MemberNotification }) {
  const invites = useMyInvites();
  const { refresh } = invites;
  const reread = useCallback(() => refresh(), [refresh]);
  const invite = invites.items?.find((i) => i.participant_id === seat) ?? null;
  // Answered already, or gone: the notice and its link say what the club knows.
  if (!invite) return invites.items === null ? <Skeleton className="h-64 rounded-xl" /> : <NoticeCard notice={notice} />;
  return <InviteDetail invite={invite} onReread={reread} />;
}

function NoticeCard({ notice }: { notice: MemberNotification }) {
  const path = appPath(notice.link);
  return (
    <Panel role="region" aria-label={COPY.noticeLabel} className="flex flex-col gap-3">
      <p className="break-words text-base font-semibold text-text-primary">{notice.headline}</p>
      {path ? <TextLink to={path} variant="standalone">{COPY.openTarget}</TextLink> : null}
    </Panel>
  );
}

/**
 * "3 unread · Mark all read", above the list rather than in the header: beside the refresh
 * button it squeezed the page's own title into two lines on a phone. Beside a pane it heads the
 * list pane (R4 form factor, SPEC 3.6).
 */
function UnreadBar({ feed, onMarkAll }: { feed: InboxFeed; onMarkAll: () => Promise<void> }) {
  return (
    // R3 X-4 — at 200% text on a phone the label wraps inside its button (never past the page).
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="min-w-0 text-sm font-medium text-text-secondary" data-unread-line="">{inboxUnreadLine(feed.count)}</p>
      <Button
        variant="outline"
        size="sm"
        className="h-auto min-h-touch max-w-full whitespace-normal py-1.5"
        pending={feed.markAll.pending}
        onClick={() => void onMarkAll()}
      >
        {COPY.markAll}
      </Button>
    </div>
  );
}
