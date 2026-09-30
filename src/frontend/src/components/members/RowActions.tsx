import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowCounterClockwise, CalendarBlank, CheckCircle, ClockCounterClockwise, DotsThree, Envelope, Fingerprint, Key, Prohibit, QrCode,
  UserCircle, UsersThree,
} from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import { ASSIGN_COPY } from "@/lib/groupsCopy";
import { ACTIONS_COPY } from "@/lib/memberDetailCopy";
import {
  ROW_ACTIONS as COPY, SUSPENDED_NOTE, bookForHref, memberHref, nightHref,
} from "@/lib/membersCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import type { MemberRow } from "./membersModel";

/**
 * What a row can do (P5): its one or two primaries on the row, everything else behind ⋯.
 *
 * <p>
 * The founder called the old row "atrocious": four unlabelled 32px icons, a native class select
 * and a Top up of a different height, no two rows the same shape. Now a row carries at most two
 * worded buttons of one size — Approve / Reject on an application, Top up on an active member —
 * and one ⋯ menu whose first three entries are LINKS (open the member, book for them, their night),
 * because navigation is a link and an action is a button. A suspended row says in words why it has
 * no Top up. Every button that starts work shows it working (`useAsyncAction`), and a second press
 * while it works is ignored.
 * </p>
 */
export type RowActionHandlers = {
  approve: (m: MemberRow) => Promise<unknown>;
  reject: (m: MemberRow) => void;
  topUp: (m: MemberRow) => void;
  fingerprints: (m: MemberRow) => void;
  reset: (m: MemberRow) => void;
  /** D8 — the member code reset, the same confirm the member's own page opens. */
  resetCode: (m: MemberRow) => void;
  resend: (m: MemberRow) => Promise<unknown>;
  /** Opens GroupAssign — the member's groups carry their rate and peak say now (D2). */
  changeGroups: (m: MemberRow) => void;
  suspend: (m: MemberRow) => void;
  reactivate: (m: MemberRow) => void;
  /** How many fingerprints the member has, for the menu's wording. */
  fingerprintCount: (m: MemberRow) => number;
};

/** One label for the reset, wherever it is offered (D8). */
const RESET_CODE_LABEL = ACTIONS_COPY.resetCode;

export function RowActions({ row, handlers }: { row: MemberRow; handlers: RowActionHandlers }) {
  const approve = useAsyncAction(() => handlers.approve(row));
  return (
    <div className="flex flex-row items-center justify-end gap-2">
      {row.status === "PendingApproval" ? (
        <>
          <Button size="sm" data-approve-row={row.user_id} pending={approve.pending} onClick={() => void approve.run()}>{COPY.approve}</Button>
          <Button size="sm" variant="danger-soft" onClick={() => handlers.reject(row)}>{COPY.reject}</Button>
        </>
      ) : null}
      {row.status === "Active" ? (
        <Button size="sm" variant="outline" onClick={() => handlers.topUp(row)}>{COPY.topUp}</Button>
      ) : null}
      {row.status === "Suspended" ? (
        <span className="min-w-0 text-right text-xs text-text-muted">{SUSPENDED_NOTE}</span>
      ) : null}
      <MemberMenu row={row} handlers={handlers} />
    </div>
  );
}

function MemberMenu({ row, handlers }: { row: MemberRow; handlers: RowActionHandlers }) {
  const active = row.status === "Active";
  // Not modal: a modal menu and the dialog it opens both fight over pointer-events on body.
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <IconButton label={COPY.more(row.full_name)} size="icon-sm" data-member-menu={row.user_id} className="shrink-0">
          <DotsThree weight="bold" aria-hidden="true" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <NavigationItems row={row} />
        <DropdownMenuSeparator />
        {active ? (
          <DropdownMenuItem onSelect={() => handlers.fingerprints(row)}>
            <Fingerprint size={16} aria-hidden="true" />{COPY.fingerprints(handlers.fingerprintCount(row))}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => handlers.reset(row)}>
          <Key size={16} aria-hidden="true" />{COPY.reset}
        </DropdownMenuItem>
        {row.membership_id ? (
          <DropdownMenuItem onSelect={() => handlers.resetCode(row)}>
            <QrCode size={16} aria-hidden="true" />{RESET_CODE_LABEL}
          </DropdownMenuItem>
        ) : null}
        {row.email_verified === false ? (
          <DropdownMenuItem onSelect={() => void handlers.resend(row)}>
            <Envelope size={16} aria-hidden="true" />{COPY.resend}
          </DropdownMenuItem>
        ) : null}
        {row.status === "Rejected" ? null : (
          <DropdownMenuItem onSelect={() => handlers.changeGroups(row)}>
            <UsersThree size={16} aria-hidden="true" />{ASSIGN_COPY.change}
          </DropdownMenuItem>
        )}
        <StandingItems row={row} handlers={handlers} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The three places a member leads — links, so they open in a new tab and read as navigation. */
function NavigationItems({ row }: { row: MemberRow }) {
  return (
    <>
      <DropdownMenuItem asChild>
        <Link to={memberHref(row.user_id)}><UserCircle size={16} aria-hidden="true" />{COPY.view}</Link>
      </DropdownMenuItem>
      {row.status === "Active" ? (
        <DropdownMenuItem asChild>
          <Link to={bookForHref(row.user_id)}><CalendarBlank size={16} aria-hidden="true" />{COPY.book}</Link>
        </DropdownMenuItem>
      ) : null}
      {row.status === "Active" || row.status === "Suspended" ? (
        <DropdownMenuItem asChild>
          <Link to={nightHref(row.user_id)}><ClockCounterClockwise size={16} aria-hidden="true" />{COPY.night}</Link>
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

/** Suspend (destructive, last, in the danger ink) or Reactivate — each opens its confirm dialog. */
function StandingItems({ row, handlers }: { row: MemberRow; handlers: RowActionHandlers }) {
  if (row.status === "Active") {
    return (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="danger" onSelect={() => handlers.suspend(row)}>
          <Prohibit size={16} aria-hidden="true" />{COPY.suspend}
        </DropdownMenuItem>
      </>
    );
  }
  if (row.status === "Rejected") {
    // F3.23: a turned-down applicant can be approved after all — the member page offers it, and
    // the list's ⋯ said nothing about it.
    return (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void handlers.approve(row)}>
          <CheckCircle size={16} aria-hidden="true" />{ACTIONS_COPY.approve}
        </DropdownMenuItem>
      </>
    );
  }
  if (row.status === "Suspended") {
    return (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => handlers.reactivate(row)}>
          <ArrowCounterClockwise size={16} aria-hidden="true" />{COPY.reactivate}
        </DropdownMenuItem>
      </>
    );
  }
  return null;
}
