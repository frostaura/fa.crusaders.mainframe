import type { MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ScrollArea } from "@/components/ScrollArea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { CaretDown, CaretUp, CaretUpDown, Envelope, Lock, ShieldCheck } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableHead, TableHeader } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ADMIN_BADGE, COLUMNS, GROUPS_COPY, MEMBERS_PAGE, UNVERIFIED, joinedOn, lastSeen, lastSeenTitle,
  memberHref, statusLabel, statusTone,
} from "@/lib/membersCopy";
import { cn, formatCredits } from "@/lib/utils";
import { initialsOf, type GroupChip, type MemberRow, type Sort, type SortKey } from "./membersModel";
import { RowActions, type RowActionHandlers } from "./RowActions";

/**
 * The members table (P5): a table when its card is wide enough, a stack of cards when it is not.
 *
 * <p>
 * <b>One DOM, two shapes, decided by the CARD's width — never the viewport's.</b> Every threshold
 * is a container query on the frame around the table, in rem: the admin rail (R16) takes 16rem at
 * `xl`, so a viewport breakpoint drew columns into a card that could not hold them; and a reader
 * who raises the browser's font size gets the same layout at a larger size — at a 24px root font a
 * 768px screen shows cards, rather than a table whose Name column has squeezed to nothing. Below
 * 48rem each row is a card (identity on top, status and balance side by side, the
 * actions along the bottom); from it, a fixed-layout table whose every column but Member is
 * declared on the spacing scale, so its total is a property of the CSS rather than of the club's
 * longest name. Below the table, cards pair up from 36rem. Columns arrive in this order as the
 * card widens: Groups from 59rem, then the date from 65rem. A column that does not fit is <b>not drawn</b> rather than drawn underneath
 * something.
 * </p>
 *
 * <p>
 * <b>Why the arithmetic works.</b> Status 8 + Balance 9 + Actions 18 + a 13rem floor for Member is
 * 48rem, where the table starts; Groups (12) arrives at 59rem, leaving Member 12; the date (6) at
 * 65rem. Below 48rem a name column narrower than 13rem truncated most real names at 768px, and
 * two cards side by side read better there than a table of initials. Actions is 18rem
 * because a pending row holds Approve, Reject and ⋯, and every `Button` is as wide as its label
 * WITH the spinner it shows while working (width-locked, so it never jumps). Change a width and
 * change its threshold with it, then re-run `e2e/admin-members-layout.spec.ts`, which measures the
 * result in Chromium at several widths, two clubs and two root font sizes.
 * </p>
 *
 * <p>
 * <b>Balance and Actions are pinned, and the two numbers are one decision.</b> Balance sits at
 * `right-72` and Actions is `w-72` — a pin whose offset no longer equals the width it clears puts
 * the balance straight back under the actions, and a balance partly covered once read
 * `123456.78 cr` as `12345`. Fixed layout means there is no overflow for the pins to hide
 * anything in; they stay as the belt to that brace.
 * </p>
 *
 * <p>
 * <b>A person's night is one click away</b> (the founder's words): the whole row opens the member,
 * and the NAME is the accessible link — a keyboard or screen-reader user reaches it as a link, a
 * mouse user can click anywhere on the row. Clicks on the row's own buttons, its menu and anything
 * portalled out of it are left alone.
 * </p>
 */

const FRAME = cn(
  "[@container(min-width:48rem)]:overflow-hidden [@container(min-width:48rem)]:rounded-xl",
  "[@container(min-width:48rem)]:border [@container(min-width:48rem)]:border-border",
  "[@container(min-width:48rem)]:bg-bg-surface [@container(min-width:48rem)]:shadow-xs",
);

const TABLE = "block [@container(min-width:48rem)]:table [@container(min-width:48rem)]:table-fixed";
const HEAD = "hidden [@container(min-width:48rem)]:table-header-group";
const BODY = "grid gap-3 [@container(min-width:36rem)]:grid-cols-2 [@container(min-width:48rem)]:table-row-group";

const ROW = cn(
  "no-lift group grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-border bg-bg-surface p-4 shadow-xs",
  "hover:border-control",
  "[@container(min-width:48rem)]:table-row [@container(min-width:48rem)]:rounded-none",
  "[@container(min-width:48rem)]:border-0 [@container(min-width:48rem)]:p-0 [@container(min-width:48rem)]:shadow-none",
);

/** Every cell's table-mode half: a real cell, a rule under it, an opaque fill that follows the row's hover. */
const CELL = cn(
  "min-w-0 text-sm",
  "[@container(min-width:48rem)]:table-cell [@container(min-width:48rem)]:border-b [@container(min-width:48rem)]:border-border",
  "[@container(min-width:48rem)]:bg-bg-surface [@container(min-width:48rem)]:px-3 [@container(min-width:48rem)]:py-3",
  "[@container(min-width:48rem)]:align-middle [@container(min-width:48rem)]:group-hover:bg-bg-muted",
  "transition-colors duration-fast ease-standard motion-reduce:transition-none",
);

/** The column's name printed above the value, in card mode only — the header row says it in a table. */
const CARD_LABEL = cn(
  "before:mb-1 before:block before:text-xs before:font-medium before:text-text-muted before:content-[attr(data-label)]",
  "[@container(min-width:48rem)]:before:content-none",
);

const COL = {
  identity: cn(
    CELL,
    "col-span-2 row-start-1",
    "[@container(min-width:48rem)]:sticky [@container(min-width:48rem)]:left-0 [@container(min-width:48rem)]:z-raised",
  ),
  status: cn(CELL, "col-start-1 row-start-2 self-center [@container(min-width:48rem)]:w-32"),
  groups: cn(CELL, CARD_LABEL, "col-span-2 [@container(min-width:48rem)]:hidden [@container(min-width:59rem)]:!table-cell [@container(min-width:48rem)]:w-48"),
  date: cn(CELL, "col-span-2 [@container(min-width:48rem)]:hidden [@container(min-width:65rem)]:!table-cell [@container(min-width:48rem)]:w-24"),
  balance: cn(
    CELL, CARD_LABEL,
    "col-start-2 row-start-2 text-right",
    "[@container(min-width:48rem)]:w-36 [@container(min-width:48rem)]:sticky [@container(min-width:48rem)]:right-72",
    "[@container(min-width:48rem)]:z-raised [@container(min-width:48rem)]:border-l",
  ),
  actions: cn(
    CELL,
    "col-span-2 border-t border-border pt-3",
    "[@container(min-width:48rem)]:w-72 [@container(min-width:48rem)]:min-w-72 [@container(min-width:48rem)]:sticky",
    "[@container(min-width:48rem)]:right-0 [@container(min-width:48rem)]:z-raised",
  ),
} as const;

/** The header cells carry the same widths, pins and thresholds as their columns. */
const TH = {
  identity: "sticky left-0 z-sticky",
  status: "w-32",
  groups: "hidden w-48 [@container(min-width:59rem)]:!table-cell",
  date: "hidden w-24 [@container(min-width:65rem)]:!table-cell",
  balance: "w-36 sticky right-72 z-sticky border-l border-border text-right",
  actions: "w-72 min-w-72 sticky right-0 z-sticky text-right",
} as const;

export type MembersTableProps = {
  rows: MemberRow[];
  /** Groups per member, or null when the column is not drawn (the read failed). */
  groupsOf: ((row: MemberRow) => GroupChip[] | undefined) | null;
  /** "joined" until the list sends `last_login_at`, then "lastSeen". */
  dateColumn: "joined" | "lastSeen";
  sort: Sort;
  onSort: (key: SortKey) => void;
  now: number;
  handlers: RowActionHandlers;
};

export function MembersTable(props: MembersTableProps) {
  const { rows, groupsOf, dateColumn, sort, onSort } = props;
  const navigate = useNavigate();
  const dateKey: SortKey = dateColumn === "lastSeen" ? "last_login_at" : "created_at";
  return (
    <div className="[container-type:inline-size]">
      <div className={FRAME}>
      <ScrollArea label={MEMBERS_PAGE.tableLabel}>
        <Table className={TABLE} containerClassName="overflow-visible" aria-label="Members">
          <TableHeader className={HEAD}>
            <tr>
              <SortHead label={COLUMNS.member} k="full_name" sort={sort} onSort={onSort} className={TH.identity} />
              <SortHead label={COLUMNS.status} k="status" sort={sort} onSort={onSort} className={TH.status} />
              {groupsOf ? <TableHead className={TH.groups}>{COLUMNS.groups}</TableHead> : null}
              <SortHead label={dateColumn === "lastSeen" ? COLUMNS.lastSeen : COLUMNS.joined} k={dateKey} sort={sort} onSort={onSort} className={TH.date} />
              <SortHead label={COLUMNS.balance} k="balance_credits" sort={sort} onSort={onSort} className={TH.balance} align="right" />
              <TableHead className={TH.actions}>{COLUMNS.actions}</TableHead>
            </tr>
          </TableHeader>
          <TableBody className={BODY}>
            {rows.map((row) => (
              <MemberTableRow key={row.user_id} row={row} {...props} onOpen={() => navigate(memberHref(row.user_id))} />
            ))}
          </TableBody>
        </Table>
      </ScrollArea>
      </div>
    </div>
  );
}

function SortHead({ label, k, sort, onSort, className, align = "left" }: {
  label: string; k: SortKey; sort: Sort; onSort: (key: SortKey) => void; className?: string; align?: "left" | "right";
}) {
  const active = sort.key === k;
  const Icon = !active ? CaretUpDown : sort.dir === "asc" ? CaretUp : CaretDown;
  return (
    <TableHead
      className={cn("overflow-hidden", className)}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
    >
      <button
        type="button"
        title={label}
        onClick={() => onSort(k)}
        className={cn(
          "no-lift inline-flex min-h-touch max-w-full items-center gap-1 uppercase tracking-overline hover:text-text-primary",
          align === "right" && "flex-row-reverse",
          active && "text-text-primary",
        )}
      >
        <span className="truncate">{label}</span>
        <Icon size={14} weight="bold" aria-hidden="true" className={cn("shrink-0", !active && "opacity-60")} />
      </button>
    </TableHead>
  );
}

/**
 * A click anywhere on the row opens the member — unless it landed on something that is already
 * its own control, or came from something rendered out of the row (a menu, a dialog) whose
 * events React still bubbles through here.
 */
function rowClick(onOpen: () => void) {
  return (event: MouseEvent<HTMLTableRowElement>) => {
    const target = event.target as HTMLElement;
    if (!event.currentTarget.contains(target)) return;
    if (target.closest("a, button, input, select, textarea, [role='menuitem'], [role='menu'], [data-no-row-open]")) return;
    if (window.getSelection()?.toString()) return;
    onOpen();
  };
}

function MemberTableRow(props: MembersTableProps & { row: MemberRow; onOpen: () => void }) {
  const { row, groupsOf, dateColumn, now, handlers, onOpen } = props;
  return (
    <tr data-interactive="" data-member-row={row.user_id} onClick={rowClick(onOpen)} className={ROW}>
      <td className={COL.identity}><Identity row={row} /></td>
      <td data-label={COLUMNS.status} className={COL.status}><StatusCell row={row} /></td>
      {groupsOf ? (
        <td data-label={COLUMNS.groups} className={cn(COL.groups, groupsHiddenOnCard(row, groupsOf))}>
          <GroupChips groups={groupsOf(row)} />
        </td>
      ) : null}
      <DateCell row={row} dateColumn={dateColumn} now={now} />
      <td data-label={COLUMNS.balance} className={COL.balance}>
        <span
          title={formatCredits(row.balance_credits)}
          className={cn("block truncate font-semibold tabular-nums", row.balance_credits < 0 ? "text-danger-strong" : "text-text-primary")}
        >
          {formatCredits(row.balance_credits)}
        </span>
      </td>
      <td data-label={COLUMNS.actions} className={COL.actions}>
        <RowActions row={row} handlers={handlers} />
      </td>
    </tr>
  );
}

/** A card with no groups says nothing about groups; the table says "No groups" in its column. */
function groupsHiddenOnCard(row: MemberRow, groupsOf: (row: MemberRow) => GroupChip[] | undefined): string | undefined {
  const groups = groupsOf(row);
  return groups && groups.length > 0 ? undefined : "hidden";
}

function Identity({ row }: { row: MemberRow }) {
  const sub = [row.membership_number, row.email].filter(Boolean).join(" · ");
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar size={40} aria-hidden="true">
        {row.photo_url ? <AvatarImage src={row.photo_url} alt="" /> : null}
        <AvatarFallback>{initialsOf(row.full_name)}</AvatarFallback>
      </Avatar>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to={memberHref(row.user_id)}
            title={row.full_name}
            className="no-lift min-w-0 truncate font-semibold text-text-primary underline-offset-2 hover:underline"
          >
            {row.full_name}
          </Link>
        </div>
        {/* Wrapped, not truncated (VIS F3-15): at 1280 the address and the rejection reason were
            cut to "wa…" and "Membership number d…" beside columns with room to spare. The
            number and the address are two lines; an address breaks anywhere, a reason at words. */}
        {row.membership_number ? <p className="truncate text-xs text-text-muted" title={row.membership_number}>{row.membership_number}</p> : null}
        <p className="break-all text-xs text-text-muted" title={sub}>{row.email}</p>
        {row.rejection_reason ? (
          <p className="line-clamp-2 break-words text-xs text-danger-strong" title={row.rejection_reason}>{row.rejection_reason}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Who can administer the club (R20). A config admin — an address in `Admins:Emails` — can only be
 * removed by an operator, and the badge says so before anybody tries: a lock, a tooltip for the
 * mouse, and the same sentence for a screen reader, because a tooltip alone reaches neither touch
 * nor assistive tech.
 */
function AdminBadge({ source }: { source: "config" | "granted" | null }) {
  const explain = source === "config" ? ADMIN_BADGE.config : ADMIN_BADGE.granted;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} data-no-row-open="" className="no-lift shrink-0 rounded-full">
          <Badge tone="brand" icon={source === "config" ? <Lock size={14} weight="bold" aria-hidden="true" /> : <ShieldCheck size={14} weight="bold" aria-hidden="true" />}>
            {ADMIN_BADGE.label}
            <span className="sr-only">{` — ${explain}`}</span>
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent>{explain}</TooltipContent>
    </Tooltip>
  );
}

function StatusCell({ row }: { row: MemberRow }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
      {row.is_admin ? <AdminBadge source={row.admin_source ?? null} /> : null}
      {row.email_verified === false ? (
        <Badge tone="warning" title={UNVERIFIED.title} icon={<Envelope size={14} weight="bold" aria-hidden="true" />}>
          {UNVERIFIED.label}
        </Badge>
      ) : null}
    </div>
  );
}

function GroupChips({ groups }: { groups: GroupChip[] | undefined }) {
  if (groups === undefined) return <Skeleton className="h-5 w-24 rounded-full" />;
  // Two chips and "+N", never three lines. A built-in group (the league group, which carries the
  // club's rates since D2 replaced the class) wears the info tone, so the rate-bearing chip stands out.
  if (groups.length === 0) return <span className="text-xs text-text-muted">{GROUPS_COPY.none}</span>;
  const rest = groups.slice(2).map((g) => g.name);
  return (
    <div className="flex flex-wrap gap-1">
      {groups.slice(0, 2).map((g) => <Badge key={g.id} tone={g.system_key ? "info" : "neutral"}>{g.name}</Badge>)}
      {rest.length > 0 ? (
        <Badge title={GROUPS_COPY.moreTitle(rest)}>
          {GROUPS_COPY.more(rest.length)}
          <span className="sr-only">{`: ${GROUPS_COPY.moreTitle(rest)}`}</span>
        </Badge>
      ) : null}
    </div>
  );
}

function DateCell({ row, dateColumn, now }: { row: MemberRow; dateColumn: "joined" | "lastSeen"; now: number }) {
  const label = dateColumn === "lastSeen" ? COLUMNS.lastSeen : COLUMNS.joined;
  const text = dateColumn === "lastSeen" ? lastSeen(row.last_login_at, now) : joinedOn(row.created_at);
  const title = dateColumn === "lastSeen" ? lastSeenTitle(row.last_login_at) : undefined;
  return (
    <td data-label={label} className={COL.date}>
      <span className="text-xs text-text-muted [@container(min-width:48rem)]:hidden">{`${label} `}</span>
      <span title={title} className="whitespace-nowrap text-xs text-text-secondary">{text}</span>
    </td>
  );
}

/** Rows shaped like the rows that are coming, while the first read is out. */
export function MembersTableSkeleton() {
  return (
    <div className="grid gap-3" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl border border-border bg-bg-surface p-4">
          <Skeleton className="size-10 rounded-full" />
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-4 w-40 max-w-full" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
          <Skeleton className="hidden h-6 w-20 rounded-full sm:block" />
          <Skeleton className="h-5 w-20" />
        </div>
      ))}
    </div>
  );
}
