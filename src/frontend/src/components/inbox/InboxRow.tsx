import { useId, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Bell, CaretRight } from "@/components/ui/icons";
import { clubInstant } from "@/lib/clubClock";
import { playersEndpoints, type MemberNotification } from "@/lib/playersApi";
import { INBOX_COPY as COPY } from "@/lib/playersCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { cn } from "@/lib/utils";
import { appPath, inboxWhen, KIND_ICON, kindWord } from "./notificationKinds";
import type { InboxFeed } from "./useInbox";

/**
 * One notice. With a link, the whole row is ONE link (it navigates) and opening it marks the
 * notice read; without one, the row is plain text with a "Mark read" button while it is unread.
 *
 * <p>
 * Unread is never colour alone: a dot, the headline in bold, and a visually hidden "Unread" in
 * the row's description.
 * </p>
 */
export function InboxRow({ notice, now, feed }: { notice: MemberNotification; now: number; feed: InboxFeed }) {
  const unread = feed.isUnread(notice);
  const to = appPath(notice.link);
  const headlineId = useId();
  const metaId = useId();
  const action = !to && unread ? <MarkReadButton notice={notice} feed={feed} describedBy={headlineId} /> : null;
  const body = <RowBody notice={notice} now={now} unread={unread} ids={{ headlineId, metaId }} trailing={Boolean(to)} action={action} />;
  const row = "flex min-h-touch w-full items-start gap-3 px-4 py-3 text-left";
  return (
    <li data-notification={notice.kind} data-unread={unread || undefined} className={cn(unread && "bg-accent-soft/40")}>
      {to ? (
        <Link
          to={to}
          onClick={() => feed.openedUnread(notice)}
          aria-labelledby={headlineId}
          aria-describedby={metaId}
          className={cn(row, "no-underline transition-colors duration-fast ease-standard hover:bg-bg-muted motion-reduce:transition-none")}
        >
          {body}
        </Link>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}

type BodyProps = {
  notice: MemberNotification;
  now: number;
  unread: boolean;
  ids: { headlineId: string; metaId: string };
  trailing: boolean;
  /** Under the text: the "Mark read" button of a notice that opens nowhere. */
  action: ReactNode;
};

function RowBody(props: BodyProps) {
  const { notice, now, unread, ids, trailing, action } = props;
  // Unknown kinds get the bell.
  const KindIcon = KIND_ICON[notice.kind] ?? Bell;
  const word = kindWord(notice.kind);
  return (
    <>
      <span aria-hidden="true" className="relative inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-bg-muted text-text-secondary">
        <KindIcon size={20} />
        {unread ? <span data-unread-dot="" className="absolute -right-0.5 -top-0.5 size-3 rounded-full bg-accent-strong ring-2 ring-bg-surface" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span id={ids.headlineId} className={cn("break-words text-text-primary", unread ? "font-bold" : "font-medium")}>
          {notice.headline}
        </span>
        <span id={ids.metaId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
          {unread ? <span className="sr-only">{`${COPY.unread}. `}</span> : null}
          {word ? <Meta>{word}</Meta> : null}
          {word ? <span aria-hidden="true">·</span> : null}
          <time dateTime={notice.created_at} title={clubInstant(notice.created_at)} className="whitespace-nowrap">
            {inboxWhen(notice.created_at, now)}
          </time>
        </span>
        {action ? <span className="flex pt-1">{action}</span> : null}
      </span>
      {trailing ? <CaretRight size={16} weight="bold" aria-hidden="true" className="mt-3 shrink-0 text-text-muted" /> : null}
    </>
  );
}

/** A kind word followed by a spoken comma, so "Invite, Today, 18:05" is not one run-on phrase. */
function Meta({ children }: { children: ReactNode }) {
  return (
    <span className="break-words">
      {children}
      <span className="sr-only">,</span>
    </span>
  );
}

function MarkReadButton({ notice, feed, describedBy }: { notice: MemberNotification; feed: InboxFeed; describedBy: string }) {
  const action = useAsyncAction(() => playersEndpoints.markRead(notice.id), {
    optimistic: { apply: () => feed.noteRead(notice, true), rollback: () => feed.noteRead(notice, false) },
    toast: { action: COPY.markOneAction, unchanged: true },
  });
  return (
    <Button
      size="sm"
      variant="outline"
      pending={action.pending}
      aria-describedby={describedBy}
      onClick={() => void action.run()}
    >
      {COPY.markOne}
    </Button>
  );
}
