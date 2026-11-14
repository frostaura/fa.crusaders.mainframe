import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ConfirmButton";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowCounterClockwise, CalendarBlank, CheckCircle, ClockCounterClockwise, DotsThree, Envelope, Fingerprint, HourglassMedium, Key,
  Prohibit, QrCode, Lock, Plus, ShieldCheck, ShieldWarning, Trash, UserCircle, UsersThree,
} from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import { ASSIGN_COPY } from "@/lib/groupsCopy";
import { ACTIONS_COPY, ADMIN_ROLE_COPY } from "@/lib/memberDetailCopy";
import {
  ROW_ACTIONS as COPY, SUSPENDED_NOTE, bookForHref, memberHref, nightHref,
} from "@/lib/membersCopy";
import { DELETE_MEMBER_COPY } from "@/lib/deleteMemberCopy";
import { FEATURES } from "@/lib/features";
import { cn } from "@/lib/utils";
import { rowAdminRoleOffer } from "./adminRoleOffer";
import type { MemberRow } from "./membersModel";

/**
 * What a row can do (P5): its one or two primaries on the row, everything else behind ⋯.
 *
 * <p>
 * The founder called the old row "atrocious": four unlabelled 32px icons, a native class select
 * and a Top up of a different height, no two rows the same shape. Now a row carries at most two
 * worded buttons of one size — Approve / Reject on an application, Sell package on an active member —
 * and one ⋯ menu whose first three entries are LINKS (open the member, book for them, their night),
 * because navigation is a link and an action is a button. A suspended row says in words why it has
 * no Sell package. "Adjust minutes" (goodwill, corrections — P13 §3.7) is in the ⋯ on every width. Every button that starts work shows it working (`useAsyncAction`), and a second press
 * while it works is ignored.
 * </p>
 */
export type RowActionHandlers = {
  approve: (m: MemberRow) => Promise<unknown>;
  reject: (m: MemberRow) => void;
  /** P13 §3.7: sell a package off the member's own shelf — how the desk takes money. */
  sell: (m: MemberRow) => void;
  /** P13 §3.7: add minutes or take them back — goodwill and corrections, no money. */
  adjust: (m: MemberRow) => void;
  /** Offered only while `FEATURES.fingerprintEnrolment` is on (P13 §9). */
  fingerprints: (m: MemberRow) => void;
  reset: (m: MemberRow) => void;
  /** D8 — the member code reset, the same confirm the member's own page opens. */
  resetCode: (m: MemberRow) => void;
  resend: (m: MemberRow) => Promise<unknown>;
  /** Opens GroupAssign — the member's groups carry their package discount and peak say (D2, P13). */
  changeGroups: (m: MemberRow) => void;
  suspend: (m: MemberRow) => void;
  reactivate: (m: MemberRow) => void;
  /**
   * R5 lane G — make an administrator or remove the rights: opens the SAME dialog the member's
   * Access tab opens (`AdminRoleDialog`); which of the two is the row's own `is_admin`.
   */
  adminRole: (m: MemberRow) => void;
  /** Opens the delete confirm (`DeleteMemberDialog`) — offered for every member, last in the ⋯. */
  deleteMember: (m: MemberRow) => void;
  /** How many fingerprints the member has, for the menu's wording. */
  fingerprintCount: (m: MemberRow) => number;
};

/** One label for the reset, wherever it is offered (D8). */
const RESET_CODE_LABEL = ACTIONS_COPY.resetCode;

/** Below a 48rem table box the card's Sell package is drawn in the ⋯ (SPEC §4.3), not beside it. */
const TABLE_ONLY = "[@container(max-width:47.99rem)]:hidden";

export function RowActions({ row, handlers, compact = false }: { row: MemberRow; handlers: RowActionHandlers; compact?: boolean }) {
  return (
    // V-1: an armed Approve is a sentence above a pair of buttons. In a no-wrap row it was squeezed
    // beside Reject and its text ran underneath it, so the armed group takes the whole row and the
    // rest wraps below it. Only an armed row may wrap: a resting row that wraps lets the table
    // squeeze the column until the buttons stack (rows measured 92.5-136.5px against 60.5-69px).
    <div data-row-actions="" className={cn(
      "flex flex-row flex-nowrap items-center justify-end gap-2",
      "has-[[data-confirm-pair]]:flex-wrap",
      "[&_[data-confirm-group]:has([data-confirm-pair])]:basis-full",
    )}>
      {row.status === "PendingApproval" ? (
        <>
          {/* BA-02: armed, never one click. One click approved straight away and the next
              applicant's row slid under the pointer, so two clicks 0.7 s apart let in somebody
              the admin never looked at. The armed control also swallows the second click of a
              double-click. */}
          <span data-approve-row={row.user_id} className="contents">
            <ConfirmButton
              idleLabel={COPY.approve}
              confirmLabel={COPY.approveConfirm(row.full_name)}
              onConfirm={async () => { await handlers.approve(row); }}
              subject={row.full_name}
              // F3.20: the queue's next step — the NEXT applicant's Approve, never this row's
              // (which is leaving) and never <body>.
              focusAfter={() => document.querySelector<HTMLElement>(`[data-approve-row]:not([data-approve-row="${row.user_id}"]) button`)}
            />
          </span>
          <Button size="sm" variant="danger-soft" onClick={() => handlers.reject(row)}>{COPY.reject}</Button>
        </>
      ) : null}
      {row.status === "Active" ? (
        <Button size="sm" variant="outline" className={TABLE_ONLY} onClick={() => handlers.sell(row)}>{COPY.sell}</Button>
      ) : null}
      {row.status === "Suspended" ? (
        <span className={cn("min-w-0 text-right text-xs text-text-muted", TABLE_ONLY)}>{SUSPENDED_NOTE}</span>
      ) : null}
      <MemberMenu row={row} handlers={handlers} compact={compact} />
    </div>
  );
}

function MemberMenu({ row, handlers, compact }: { row: MemberRow; handlers: RowActionHandlers; compact: boolean }) {
  const active = row.status === "Active";
  // Not modal: a modal menu and the dialog it opens both fight over pointer-events on body.
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        {/* 44px on a card (R5 X5-12), where it is the row's one control; 36 beside the table's buttons. */}
        <IconButton label={COPY.more(row.full_name)} size="icon-sm" data-member-menu={row.user_id} className="shrink-0 [@container(max-width:47.99rem)]:size-11">
          <DotsThree weight="bold" aria-hidden="true" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {active ? (
          <>
            {compact ? (
              <DropdownMenuItem onSelect={() => handlers.sell(row)}>
                <Plus size={16} aria-hidden="true" />{COPY.sell}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => handlers.adjust(row)}>
              <HourglassMedium size={16} aria-hidden="true" />{COPY.adjust}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <NavigationItems row={row} />
        <DropdownMenuSeparator />
        {active && FEATURES.fingerprintEnrolment ? (
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
        <AdminRoleItem row={row} handlers={handlers} />
        <StandingItems row={row} handlers={handlers} />
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="danger" data-delete-member-item="" onSelect={() => handlers.deleteMember(row)}>
          <Trash size={16} aria-hidden="true" />{DELETE_MEMBER_COPY.menu}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Make administrator / Remove admin rights (R5 lane G: "there is still no way to make a user an
 * admin … that should be easy from the members list"). The switch's own rule (`adminRoleOffer`):
 * a config admin's item is shown disabled with the reason, and so is a grant to someone who is not
 * active — muted by ink, not opacity, so the reason stays readable (a 50 % row fell under 4.5:1).
 * Absent when the list did not say whether they are an admin.
 */
function AdminRoleItem({ row, handlers }: { row: MemberRow; handlers: RowActionHandlers }) {
  const offer = rowAdminRoleOffer(row);
  if (!offer) return null;
  const label = offer.grant ? ADMIN_ROLE_COPY.grantConfirm : ADMIN_ROLE_COPY.revokeConfirm;
  const Icon = offer.locked ? Lock : offer.grant ? ShieldCheck : ShieldWarning;
  return (
    <DropdownMenuItem
      data-admin-role-item={offer.grant ? "grant" : "revoke"}
      variant={!offer.grant && !offer.locked ? "danger" : "default"}
      disabled={offer.locked !== null}
      className="py-2 data-[disabled]:opacity-100"
      onSelect={() => handlers.adminRole(row)}
    >
      <Icon size={16} aria-hidden="true" className="shrink-0 self-start mt-0.5" />
      <span className="flex min-w-0 flex-col">
        <span className={offer.locked ? "text-text-secondary" : undefined}>{label}</span>
        {offer.short ? <span className="text-xs text-text-secondary">{offer.short}</span> : null}
      </span>
    </DropdownMenuItem>
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
