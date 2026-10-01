import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowCounterClockwise, CalendarBlank, CheckCircle, ClockCounterClockwise, DotsThree, Envelope, Fingerprint, Key, Prohibit, QrCode,
  Lock, Plus, ShieldCheck, ShieldWarning, UserCircle, UsersThree,
} from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import { ASSIGN_COPY } from "@/lib/groupsCopy";
import { ACTIONS_COPY, ADMIN_ROLE_COPY } from "@/lib/memberDetailCopy";
import {
  ROW_ACTIONS as COPY, SUSPENDED_NOTE, bookForHref, memberHref, nightHref,
} from "@/lib/membersCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { cn } from "@/lib/utils";
import { rowAdminRoleOffer } from "./adminRoleOffer";
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
  /**
   * R5 lane G — make an administrator or remove the rights: opens the SAME dialog the member's
   * Access tab opens (`AdminRoleDialog`); which of the two is the row's own `is_admin`.
   */
  adminRole: (m: MemberRow) => void;
  /** How many fingerprints the member has, for the menu's wording. */
  fingerprintCount: (m: MemberRow) => number;
};

/** One label for the reset, wherever it is offered (D8). */
const RESET_CODE_LABEL = ACTIONS_COPY.resetCode;

/** Below a 48rem table box the card's Top up is drawn in the ⋯ (SPEC §4.3), not beside it. */
const TABLE_ONLY = "[@container(max-width:47.99rem)]:hidden";

export function RowActions({ row, handlers, compact = false }: { row: MemberRow; handlers: RowActionHandlers; compact?: boolean }) {
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
        <Button size="sm" variant="outline" className={TABLE_ONLY} onClick={() => handlers.topUp(row)}>{COPY.topUp}</Button>
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
        {active && compact ? (
          <>
            <DropdownMenuItem onSelect={() => handlers.topUp(row)}>
              <Plus size={16} aria-hidden="true" />{COPY.topUp}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
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
        <AdminRoleItem row={row} handlers={handlers} />
        <StandingItems row={row} handlers={handlers} />
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
