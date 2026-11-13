import { type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ScrollArea } from "@/components/ScrollArea";
import { useBoxAtLeast } from "@/components/admin/useBoxAtLeast";
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
import { cn } from "@/lib/utils";
import { minutesCompact } from "@/lib/minutes";
import { KeptMinutes } from "./KeptMinutes";
import { initialsOf, type GroupChip, type MemberRow, type Sort, type SortKey } from "./membersModel";
import { EmailWithBreaks } from "./EmailWithBreaks";
import { RowActions, type RowActionHandlers } from "./RowActions";
import { useLongNameCards } from "./useLongNameCards";

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
 * longest name. Below the table, cards pair up from 41rem (R7 L7-1). Columns arrive in this order as the
 * card widens: Groups from 59rem, then the date from 65rem. A column that does not fit is <b>not drawn</b> rather than drawn underneath
 * something.
 * </p>
 *
 * <p>
 * <b>Why the arithmetic works.</b> Status 8 + Balance 9 + Actions 16 + a 13rem floor for Member is
 * 46rem, inside the 48rem where the table starts; Groups (9) arrives at 59rem, leaving Member 17;
 * the date (7, BA-16) at 65rem (R4 V-14 narrowed Actions from 18 and Groups from 12). Below 48rem a name column narrower than 13rem truncated most real names at 768px, and
 * two cards side by side read better there than a table of initials. Actions is 18rem
 * because a pending row holds Approve, Reject and ⋯, and every `Button` is as wide as its label
 * WITH the spinner it shows while working (width-locked, so it never jumps). Change a width and
 * change its threshold with it, then re-run `e2e/admin-members-layout.spec.ts`, which measures the
 * result in Chromium at several widths, two clubs and two root font sizes.
 * </p>
 *
 * <p>
 * <b>Balance and Actions are pinned, and the two numbers are one decision.</b> Balance sits at
 * `right-64` and Actions is `w-64` — a pin whose offset no longer equals the width it clears puts
 * the balance straight back under the actions, and a balance partly covered once read
 * `85 d 17 h 36 min` as `85 d 17`. Fixed layout means there is no overflow for the pins to hide
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
/** `grid-cols-1`, not an implicit column: that one is floored at the card's widest word and ran the
 *  compact card past a 390 phone at 200 % text (gotchas-frontend-layout). */
/** Cards pair up from 41rem (R7 L7-1: from 36rem each card was ~17.6rem, a NARROW card — see below). */
const BODY = "grid grid-cols-1 gap-3 [@container(min-width:41rem)]:grid-cols-2 [@container(min-width:48rem)]:table-row-group";

/*
 * R7 L7-1 — a NARROW card (a list box under 20rem: a 320 phone, or any phone at 200 % text). Beside
 * the who column, the balance and the badges took half the card and the ⋯ its 44px, so at 390/200 %
 * a name ran a letter per line, the balance read "0 min…" and the ⋯ was pushed off the card. Narrow,
 * the who takes the card's whole first line; the balance and then the badges go under it, with the
 * ⋯ beside them. Under 13rem (200 % text) the avatar stands over the name, so the name has the
 * card's full width and a word is never cut. Every narrow rule is `[@container(max-width:19.99rem)]`
 * (avatar: 12.99rem), spelled out in full on each class so Tailwind's scanner sees it.
 */

/**
 * A card is COMPACT (R4 form factor, SPEC §3.8/§4.3; R5 to the spec's ~72px): a three-column grid
 * — who (avatar, name, number) on the left over two lines; the balance over the status beside it;
 * the ⋯ at the end, with Top up inside it. R4's wrapping row put status and the actions on a line
 * of their own and measured ~126px a member. An application keeps Approve and Reject on a third
 * line, because those two are the queue. Groups, the date and the address are the record's to
 * show; the search still finds a member by address.
 */
const ROW = cn(
  // L6-9: the who column keeps at least half the card; the badges and the balance beside it WRAP
  // in what is left (min 0) instead of taking their one-line width and cutting the name to nothing.
  "no-lift group grid grid-cols-[minmax(50%,1fr)_minmax(0,auto)_auto] items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-bg-surface p-3 shadow-xs",
  "[@container(max-width:19.99rem)]:grid-cols-[minmax(0,1fr)_auto] [@container(max-width:19.99rem)]:gap-y-2",
  // R14 L14-3 — under 13rem (the avatar over the name) the inset is p-2, and the name below steps
  // down a size, so a 17-letter surname keeps whole at 320 / 200 % (248px in 206 broke it).
  "[@container(max-width:12.99rem)]:p-2",
  // A long-name card's second line is balance · badges: the balance as wide as it is, the badges
  // in ONE wrapping row across the rest ("Active Admin", then "Unverified"), not a column of three
  // in the who column's leftover (R14 review: 148px, lopsided, ⋯ floating mid-height).
  "[@container(min-width:20rem)_and_(max-width:47.99rem)]:data-[long-name]:grid-cols-[auto_minmax(0,1fr)_auto]",
  "hover:border-control",
  // TableBody's `[&_tr:last-child]:border-0` (0,2,1) is the TABLE's bottom rule; on a card it took
  // the last card's whole border (R14 review). A card keeps its 1px — width only, so the colour
  // (and hover:border-control) is the card's. The table (48rem) keeps the primitive's rule.
  "[@container(max-width:47.99rem)]:!border",
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

/** The address under the name: a table narrower than the Email column's 76rem. One rule per range (gotchas-frontend-layout). */
const EMAIL_UNDER_NAME = "[@container(min-width:48rem)_and_(max-width:75.99rem)]:block";

/** The table's own Email column (V-14): from a 76rem box — 2xl beside the rail, 1920 with room to spare. */
const EMAIL_COLUMN = "hidden [@container(min-width:48rem)]:hidden [@container(min-width:76rem)]:!table-cell";
/** Groups widen to 12rem where the email has its own column and the member column has the room. */
const GROUPS_WIDE = "[@container(min-width:76rem)]:w-48";

/*
 * R14 L14-3 — a card whose name holds a word wider than the who column's floor (`useLongNameCards`
 * sets `data-long-name` on the row) puts the who across the card's first line, the balance under
 * it on the left and the badges in a right-aligned wrapping row beside it; the ⋯ stays at the end.
 * Card range only (20rem to the table), written whole: the narrow card and the table already give
 * the name the row.
 */
const LONG_WHO = "[@container(min-width:20rem)_and_(max-width:47.99rem)]:group-data-[long-name]:[grid-column:1/3] [@container(min-width:20rem)_and_(max-width:47.99rem)]:group-data-[long-name]:[grid-row:1]";
const LONG_BALANCE = cn(
  "[@container(min-width:20rem)_and_(max-width:47.99rem)]:group-data-[long-name]:[grid-column:1] [@container(min-width:20rem)_and_(max-width:47.99rem)]:group-data-[long-name]:[grid-row:2]",
  "[@container(min-width:20rem)_and_(max-width:47.99rem)]:group-data-[long-name]:justify-self-start [@container(min-width:20rem)_and_(max-width:47.99rem)]:group-data-[long-name]:self-center",
  "[@container(min-width:20rem)_and_(max-width:47.99rem)]:group-data-[long-name]:text-left",
);

const COL = {
  identity: cn(
    CELL,
    LONG_WHO,
    "col-start-1 row-span-2 row-start-1",
    "[@container(max-width:19.99rem)]:col-span-2 [@container(max-width:19.99rem)]:row-span-1",
    "[@container(min-width:48rem)]:sticky [@container(min-width:48rem)]:left-0 [@container(min-width:48rem)]:z-raised",
  ),
  email: cn(CELL, EMAIL_COLUMN, "[@container(min-width:48rem)]:w-72"),
  status: cn(
    CELL, "col-start-2 row-start-2 justify-self-end [@container(min-width:48rem)]:w-32",
    "[@container(max-width:19.99rem)]:col-start-1 [@container(max-width:19.99rem)]:row-start-3 [@container(max-width:19.99rem)]:justify-self-start",
  ),
  // `hidden` at the table's own threshold too: CELL makes every cell a table-cell from 48rem, and
  // a cell drawn under a header that is not shifts every column after it (`hidden` sorts last).
  groups: cn(CELL, "hidden [@container(min-width:48rem)]:hidden [@container(min-width:59rem)]:!table-cell [@container(min-width:48rem)]:w-36", GROUPS_WIDE),
  date: cn(CELL, "hidden [@container(min-width:48rem)]:hidden [@container(min-width:65rem)]:!table-cell [@container(min-width:48rem)]:w-24"),
  balance: cn(
    CELL,
    LONG_BALANCE,
    "col-start-2 row-start-1 self-end text-right",
    "[@container(max-width:19.99rem)]:col-start-1 [@container(max-width:19.99rem)]:row-start-2",
    "[@container(max-width:19.99rem)]:justify-self-start [@container(max-width:19.99rem)]:text-left",
    "[@container(min-width:48rem)]:w-36 [@container(min-width:48rem)]:sticky [@container(min-width:48rem)]:right-64",
    "[@container(min-width:48rem)]:z-raised [@container(min-width:48rem)]:border-l",
  ),
  actions: cn(
    CELL,
    "col-start-3 row-span-2 row-start-1",
    "[@container(max-width:19.99rem)]:col-start-2 [@container(max-width:19.99rem)]:row-start-2 [@container(max-width:19.99rem)]:self-center",
    "[@container(min-width:48rem)]:w-64 [@container(min-width:48rem)]:min-w-64 [@container(min-width:48rem)]:sticky",
    "[@container(min-width:48rem)]:right-0 [@container(min-width:48rem)]:z-raised",
  ),
} as const;

/** On a card, an application's actions run the card's width on a third line. */
const APPLICATION_ACTIONS = cn(
  "col-span-3 col-start-1 row-span-1 row-start-3",
  "[@container(max-width:19.99rem)]:col-span-2 [@container(max-width:19.99rem)]:col-start-1 [@container(max-width:19.99rem)]:row-start-4",
);

/**
 * The header cells carry the same widths, pins and thresholds as their columns.
 *
 * <p>
 * R4 V-14: at 1280 the actions column (18rem) held Top up and ⋯ in half its width and the balance
 * (9rem) a figure a third of it, while member emails wrapped over two lines. Actions are 16rem —
 * Approve, Reject and ⋯ side by side — and groups 9rem; the balance keeps 9rem, which is what "694 d 10 h 39 min"
 * needs whole (admin-members-layout.spec); the member column takes the rest — 64px more than
 * before, at the same column thresholds (which now leave it more than its 13rem floor).
 * </p>
 */
const TH = {
  identity: "sticky left-0 z-sticky",
  email: cn("w-72", EMAIL_COLUMN),
  status: "w-32",
  groups: cn("hidden w-36 [@container(min-width:59rem)]:!table-cell", GROUPS_WIDE),
  // BA-16: 7rem, not 6 — "JOINED" in tracked capitals beside its sort caret read "JOIN…" at 1440.
  date: "hidden w-28 [@container(min-width:65rem)]:!table-cell",
  balance: "w-36 sticky right-64 z-sticky border-l border-border text-right",
  actions: "w-64 min-w-64 sticky right-0 z-sticky text-right",
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

/**
 * R5 V-14: a Groups column where nobody on the page is in a group is 9rem of "No groups" beside
 * addresses wrapping for want of it — so it is not drawn. Undefined (still reading) keeps it.
 */
function groupsWorthAColumn(rows: MemberRow[], groupsOf: MembersTableProps["groupsOf"]): MembersTableProps["groupsOf"] {
  if (!groupsOf) return null;
  return rows.some((row) => (groupsOf(row)?.length ?? 1) > 0) ? groupsOf : null;
}

export function MembersTable(props: MembersTableProps) {
  const { rows, dateColumn, sort, onSort } = props;
  const groupsOf = groupsWorthAColumn(rows, props.groupsOf);
  const navigate = useNavigate();
  // The same 48rem the container queries use: below it the card's Top up lives in the ⋯ (§4.3).
  const [box, table] = useBoxAtLeast(48);
  const cards = useLongNameCards();
  const dateKey: SortKey = dateColumn === "lastSeen" ? "last_login_at" : "created_at";
  return (
    <div ref={box} className="[container-type:inline-size]">
      <div ref={cards} data-members-frame="" className={FRAME}>
      <ScrollArea label={MEMBERS_PAGE.tableLabel}>
        <Table className={TABLE} containerClassName="overflow-visible" aria-label="Members">
          <TableHeader className={HEAD}>
            <tr>
              <SortHead label={COLUMNS.member} k="full_name" sort={sort} onSort={onSort} className={TH.identity} />
              <TableHead className={TH.email}>{COLUMNS.email}</TableHead>
              <SortHead label={COLUMNS.status} k="status" sort={sort} onSort={onSort} className={TH.status} />
              {groupsOf ? <TableHead className={TH.groups}>{COLUMNS.groups}</TableHead> : null}
              <SortHead label={dateColumn === "lastSeen" ? COLUMNS.lastSeen : COLUMNS.joined} k={dateKey} sort={sort} onSort={onSort} className={TH.date} />
              <SortHead label={COLUMNS.balance} k="balance_minutes" sort={sort} onSort={onSort} className={TH.balance} align="right" />
              <TableHead className={TH.actions}>{COLUMNS.actions}</TableHead>
            </tr>
          </TableHeader>
          <TableBody className={BODY}>
            {rows.map((row) => (
              <MemberTableRow key={row.user_id} row={row} {...props} groupsOf={groupsOf} compact={!table} onOpen={() => navigate(memberHref(row.user_id))} />
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
          // `-mx-1 px-1` (R16 FE16s2): the frame insets this ring, and inset it ran over the label's first letter.
          "no-lift -mx-1 inline-flex min-h-touch max-w-full items-center gap-1 px-1 uppercase tracking-overline hover:text-text-primary",
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

function MemberTableRow(props: MembersTableProps & { row: MemberRow; onOpen: () => void; compact: boolean }) {
  const { row, groupsOf, dateColumn, now, handlers, onOpen, compact } = props;
  return (
    <tr data-interactive="" data-member-row={row.user_id} onClick={rowClick(onOpen)} className={ROW}>
      <td className={COL.identity}><Identity row={row} /></td>
      <td data-label={COLUMNS.email} className={COL.email}>
        <p className="break-words text-xs text-text-secondary" title={row.email}><EmailWithBreaks email={row.email} /></p>
      </td>
      <td data-label={COLUMNS.status} className={COL.status}><StatusCell row={row} /></td>
      {groupsOf ? (
        <td data-label={COLUMNS.groups} className={cn(COL.groups, groupsHiddenOnCard(row, groupsOf))}>
          <GroupChips groups={groupsOf(row)} />
        </td>
      ) : null}
      <DateCell row={row} dateColumn={dateColumn} now={now} />
      <td data-label={COLUMNS.balance} className={COL.balance}>
        <span title={minutesCompact(row.balance_minutes)} className="block whitespace-normal font-semibold text-text-primary">
          <KeptMinutes value={row.balance_minutes} />
        </span>
      </td>
      {/* An application's Approve and Reject take the card's third line (the queue's two words). */}
      <td data-label={COLUMNS.actions} className={cn(COL.actions, row.status === "PendingApproval" && APPLICATION_ACTIONS)}>
        <RowActions row={row} handlers={handlers} compact={compact} />
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
    <div className="flex min-w-0 items-center gap-3 [@container(max-width:12.99rem)]:flex-col [@container(max-width:12.99rem)]:items-start">
      <Avatar size={40} aria-hidden="true">
        {row.photo_url ? <AvatarImage src={row.photo_url} alt="" /> : null}
        <AvatarFallback>{initialsOf(row.full_name)}</AvatarFallback>
      </Avatar>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to={memberHref(row.user_id)}
            title={row.full_name}
            data-member-name=""
            // A 44px target on a 20px line (R5 X5-12): the padding grows the hit area, the margin
            // gives the line its height back.
            // L6-9: on a phone's card the name WRAPS, never cut — the badges beside it took the
            // width and cut "Thandiwe Mokoena-Dlamini" to nothing; the table, whose Member column
            // is sized for it, keeps one line.
            className={cn(
              "no-lift -my-3 min-w-0 py-3 font-semibold text-text-primary underline-offset-2 hover:underline",
              "break-words hyphens-auto [@container(max-width:12.99rem)]:text-xs [@container(min-width:48rem)]:truncate",
            )}
          >
            {row.full_name}
          </Link>
        </div>
        {/* Wrapped, not truncated (VIS F3-15): at 1280 the address and the rejection reason were
            cut to "wa…" and "Membership number d…" beside columns with room to spare. The
            number and the address are two lines; an address breaks anywhere, a reason at words. */}
        {row.membership_number ? <p className="truncate text-xs text-text-muted" title={row.membership_number}>{row.membership_number}</p> : null}
        {/* Under the name only in a table without its own Email column (V-14); a compact card
            leaves it to the record. */}
        <p className={cn("hidden break-words text-xs text-text-muted", EMAIL_UNDER_NAME)} title={sub}><EmailWithBreaks email={row.email} /></p>
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
    <div className="flex flex-wrap items-center justify-end gap-1 [@container(max-width:19.99rem)]:justify-start [@container(min-width:48rem)]:justify-start">
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

/** A group's name can be longer than the cell: the pill stops at the cell's edge with an ellipsis (the full name is its title), never runs under the pinned balance. */
const CHIP_FITS_CELL = "min-w-0 max-w-full [&>span]:min-w-0 [&>span]:truncate";

function GroupChips({ groups }: { groups: GroupChip[] | undefined }) {
  if (groups === undefined) return <Skeleton className="h-5 w-24 rounded-full" />;
  // Two chips and "+N", never three lines. A built-in group (the league group, which carries the
  // club's rates since D2 replaced the class) wears the info tone, so the rate-bearing chip stands out.
  if (groups.length === 0) return <span className="text-xs text-text-muted">{GROUPS_COPY.none}</span>;
  const rest = groups.slice(2).map((g) => g.name);
  return (
    <div className="flex flex-wrap gap-1">
      {groups.slice(0, 2).map((g) => <Badge key={g.id} tone={g.system_key ? "info" : "neutral"} title={g.name} className={CHIP_FITS_CELL}>{g.name}</Badge>)}
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
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl border border-border bg-bg-surface p-3">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-2">
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
