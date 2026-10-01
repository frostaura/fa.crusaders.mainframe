import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Interactable } from "@/components/ui/interactable";
import { Skeleton } from "@/components/ui/skeleton";
import type { Invite } from "@/lib/playersApi";
import { INVITES_COPY, invitedLine, payByLine, playersCount } from "@/lib/playersCopy";
import { cn, formatCredits } from "@/lib/utils";
import { inviteStatus, inviteWhen, organiserName } from "./inviteFacts";

/**
 * One invite in the list — who asked, which court and when, how many are playing, your share and
 * where the seat stands. The whole card is the button that opens the accept sheet (or, for a link
 * the member opened, the link back to it), so it carries the card watermark (design-system.md:
 * interactive cards).
 */
type CardProps = {
  invite: Invite;
  /** Opens the accept sheet. */
  onOpen?: (invite: Invite) => void;
  /**
   * R1 F2.5 — or navigates: an open seat from a link the member opened is answered through its
   * own link page (the seat routes refuse an unclaimed seat), so that card is a link.
   */
  to?: string;
  /** A line above the rest — where the invite came from. */
  note?: string;
  /** R4 form factor: the invite open in the split view's pane beside the list. */
  current?: boolean;
  /**
   * R5 §3.5 — the card's own answers (Decline · Accept) at its foot, on a phone. Given, the card is
   * no longer one button: the frame is a box, its body the button that opens the invite (stretched
   * over the card), and the answers sit in the frame BESIDE it — never a button inside a button.
   */
  actions?: ReactNode;
};

const CARD_CLASS = "flex w-full min-h-touch items-start gap-3 rounded-xl border border-border bg-bg-surface p-4 text-left shadow-xs no-underline";

export function InviteCard({ invite, onOpen, to, note, current, actions }: CardProps) {
  const body = <CardBody invite={invite} note={note} />;
  if (actions) return <CardWithActions invite={invite} onOpen={onOpen} to={to} current={current} body={body} actions={actions} />;
  return (
    <Interactable asChild surface="card" watermark>
      {to ? (
        <Link to={to} data-invite={invite.participant_id} data-invite-pending="" data-split-item="" className={CARD_CLASS}>{body}</Link>
      ) : (
        <button
          type="button" onClick={() => onOpen?.(invite)} data-invite={invite.participant_id} data-split-item=""
          aria-current={current ? "true" : undefined} className={cn(CARD_CLASS, current && "border-accent-strong ring-1 ring-accent-strong")}
        >
          {body}
        </button>
      )}
    </Interactable>
  );
}

/** The body opens the invite over the whole card (`after:` inset); the answers sit above that layer. */
const OPEN_CLASS = "flex w-full min-h-touch items-start gap-3 text-left no-underline after:absolute after:inset-0 after:rounded-xl after:content-['']";

type WithActionsProps = Pick<CardProps, "invite" | "onOpen" | "to" | "current"> & { body: ReactNode; actions: ReactNode };

function CardWithActions({ invite, onOpen, to, current, body, actions }: WithActionsProps) {
  return (
    <Interactable asChild surface="card" watermark>
      <div className={cn(CARD_CLASS, "relative flex-col items-stretch gap-0", current && "border-accent-strong ring-1 ring-accent-strong")}>
        {to ? (
          <Link to={to} data-invite={invite.participant_id} data-invite-pending="" data-split-item="" className={OPEN_CLASS}>{body}</Link>
        ) : (
          <button
            type="button" onClick={() => onOpen?.(invite)} data-invite={invite.participant_id} data-split-item=""
            aria-current={current ? "true" : undefined} className={OPEN_CLASS}
          >
            {body}
          </button>
        )}
        <div data-invite-actions="" className="relative z-10 flex flex-wrap justify-end gap-2 pt-3">{actions}</div>
      </div>
    </Interactable>
  );
}

function CardBody({ invite, note }: { invite: Invite; note?: string }): ReactNode {
  const name = organiserName(invite);
  const status = inviteStatus(invite);
  return (
    <>
      <Avatar size={40}>
        {invite.organiser?.photo_url ? <AvatarImage src={invite.organiser.photo_url} alt="" /> : null}
        <AvatarFallback name={name} />
      </Avatar>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        {note ? <span className="text-xs font-semibold uppercase tracking-overline text-text-muted">{note}</span> : null}
        <span className="break-words text-base font-semibold text-text-primary">{invitedLine(name, invite.open_link)}</span>
        <span className="break-words text-sm text-text-secondary">
          {`${invite.court_name ?? INVITES_COPY.court} · ${inviteWhen(invite)} · ${playersCount(invite.players)}`}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
          <span className="text-sm font-semibold tabular-nums text-text-primary">
            {`${INVITES_COPY.yourShare} ${formatCredits(invite.share_credits)}`}
          </span>
          <Badge tone={status.tone}>{status.text}</Badge>
        </span>
        {invite.share_credits > 0 ? <span className="text-xs text-text-muted">{payByLine(invite.share_deadline)}</span> : null}
      </span>
    </>
  );
}

/** The list while it is read — the card's own shape, three times. */
export function InviteListSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1, 2].map((n) => (
        <div key={n} className="flex items-start gap-3 rounded-xl border border-border bg-bg-surface p-4">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-3/5" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
