import { useCallback, useRef, useState } from "react";
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
import { usePickParam, useSplitLayout } from "@/components/ui/use-split-layout";
import { appPath } from "@/components/inbox/notificationKinds";
import { InviteDetail } from "@/components/players/invites/InviteDetail";
import { useKeptInvites, type KeptInvites } from "@/lib/offline/useKeptInvites";
import { OfflineNothingKeptRetry } from "@/components/bookings/OfflineNothingKeptRetry";
import { OFFLINE_COPY } from "@/lib/offline/offlineCopy";
import type { Invite, MemberNotification } from "@/lib/playersApi";
import { BookingDetailPanel } from "./BookingDetail";
import { StaleNotice } from "@/components/shell/StaleNotice";
import { cn } from "@/lib/utils";
import { keepFiguresWhole } from "@/components/ui/figure-text";
import { INBOX_COPY as COPY, INVITES_COPY, inboxUnreadLine } from "@/lib/playersCopy";
import { SPLIT_PANE_COPY } from "@/lib/inboxCopy";
import { typography } from "@/lib/typography";

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
  // R4 form factor (SPEC 3.6): beside a pane, the list stands beside the notice's target, opened
  // in place. R5 X5-3 — "beside a pane" is the split view's own measure (its box, in rem), never the
  // viewport: at 200 % text on a desktop the two disagreed and a pick hid the list with no way back.
  const layout = useSplitLayout(SPLIT_AT);
  const wide = layout.split;
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
      <SplitView
        layout={layout}
        listLabel={COPY.listLabel}
        listWidth="26rem"
        splitAt={SPLIT_AT}
        list={listPane}
        detail={picked.notice ? <NoticeTarget key={picked.notice.id} notice={picked.notice} /> : null}
        placeholder={<StateBlock empty emptyIcon={Bell} emptyTitle={COPY.pickTitle} emptyHint={COPY.pickHint} />}
        back={{ label: SPLIT_PANE_COPY.backToNotifications, onBack: picked.unpick }}
        pickedKey={picked.notice?.id ?? null}
        announce={picked.notice ? SPLIT_PANE_COPY.showing(picked.notice.headline) : undefined}
      />
    </PageShell>
  );
}

const SPLIT_AT = "56rem";

/** The notice open in the pane: `?n=` — kept while the list re-reads around it. */
function usePickedNotice(items: MemberNotification[]) {
  const { value: id, pick: pickId, unpick } = usePickParam("n");
  const notice = id ? items.find((n) => n.id === id) ?? null : null;
  const pick = useCallback((next: MemberNotification) => pickId(next.id), [pickId]);
  return { notice, pick, unpick };
}

const INVITE_PATH = /^\/invites\/([^/?#]+)/;

/** The `?seat=` an app path names, or null. */
function seatOf(path: string | null): string | null {
  const query = path?.split("#")[0].split("?")[1];
  return query ? new URLSearchParams(query).get("seat") : null;
}

/**
 * A notice's target, in place (SPEC 3.6): an invite answered here; a share, a payment or a change
 * to a game as that booking's own panel; anything else as the notice with the way to it.
 */
function NoticeTarget({ notice }: { notice: MemberNotification }) {
  const path = appPath(notice.link);
  const seat = path?.match(INVITE_PATH)?.[1] ?? null;
  if (seat) return <InviteTarget seat={seat} notice={notice} />;
  // R5 M5-8 — a "you were taken off" notice names the member's seat in its path (`?seat=`): the
  // pane then says what became of it instead of "Booking not found", as the full page does.
  if (notice.booking_id) return <BookingDetailPanel bookingId={notice.booking_id} seatId={seatOf(path)} />;
  return <NoticeCard notice={notice} />;
}

function InviteTarget({ seat, notice }: { seat: string; notice: MemberNotification }) {
  const invites = useKeptInvites();
  const { refresh } = invites;
  const reread = useCallback(() => refresh(), [refresh]);
  const fromList = invites.items?.find((i) => i.participant_id === seat) ?? null;
  // R5 M5-4 — the invite answered here is held while its answer lands: an accepted seat leaves the
  // open-invites list on the re-read, and the pane collapsed to the bare notice, losing "You're in —
  // 16 min paid to Olga". As the Invites page does, the last invite shown stays until another is
  // picked (this component is keyed by the notice).
  const [held, setHeld] = useState<Invite | null>(null);
  if (fromList && fromList !== held) setHeld(fromList);
  const invite = fromList ?? held;
  // Answered already, or gone: the notice and its link say what the club knows.
  if (!invite && invites.items !== null) return <NoticeCard notice={notice} />;
  // FM-3 — a FAILED read is not a loading one: three states, never a skeleton for ever. The notice
  // and its link stay under the failure, so the member still has the way to the invite's own page.
  if (!invite && invites.error != null) return <InviteReadFailed invites={invites} notice={notice} onRetry={reread} />;
  if (!invite) return <Skeleton className="h-64 rounded-xl" />;
  return <InviteDetail invite={invite} onReread={reread} />;
}

function InviteReadFailed({ invites, notice, onRetry }: { invites: KeptInvites; notice: MemberNotification; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-4" data-invite-read-failed="">
      {invites.offline
        ? <OfflineNothingKeptRetry line={OFFLINE_COPY.nothingKept.invites} onRetry={onRetry} />
        : <StateBlock error={invites.error} action={INVITES_COPY.readAction} onRetry={onRetry} />}
      <NoticeCard notice={notice} />
    </div>
  );
}

function NoticeCard({ notice }: { notice: MemberNotification }) {
  const path = appPath(notice.link);
  return (
    <Panel role="region" aria-label={COPY.noticeLabel} className="flex flex-col gap-3">
      {/* A heading, so a pick opened while stacked has somewhere for focus to land (R5 X5-3). */}
      <h2 className={cn(typography({ variant: "h3" }), "break-words")}>{keepFiguresWhole(notice.headline)}</h2>
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
