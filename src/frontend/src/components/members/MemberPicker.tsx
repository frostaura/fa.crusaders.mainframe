import { NavLink } from "react-router-dom";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MEMBERS_PAGE as COPY, memberHref, membersCount, statusLabel, statusTone } from "@/lib/membersCopy";
import { cn } from "@/lib/utils";
import { Minutes } from "@/components/Minutes";
import { initialsOf, type MemberRow } from "./membersModel";

/**
 * The members list BESIDE a member's record (R4 form factor, SPEC §3.8): a dense list, not the
 * table — name, number, status, balance — one link per member.
 *
 * <p>
 * <b>A link, and the picked one is the page.</b> Each row is a `NavLink` to the member, so it
 * opens in a new tab like any link, and the one showing carries `aria-current="page"` (also on
 * the member's tabs, whose URLs sit under it). Rows carry `data-split-item`: the split view walks
 * them with ↑/↓, Home and End, and Enter opens one — so a queue is cleared with ↓, Enter, Approve.
 * </p>
 *
 * <p>
 * Status is a word only where it is not the everyday one: an Active row says nothing, so the eye
 * lands on Pending, Suspended and Rejected. A negative balance reads in the danger ink with its
 * minus, never by colour alone.
 * </p>
 */
export type MemberPickerProps = {
  rows: MemberRow[];
  total: number;
  shown: number;
  onMore: () => void;
};

export function MemberPicker({ rows, total, shown, onMore }: MemberPickerProps) {
  const visible = rows.slice(0, shown);
  const left = rows.length - visible.length;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-xs text-text-secondary" aria-live="polite">{membersCount(rows.length, total)}</p>
      <ul aria-label={COPY.pickerLabel} className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-bg-surface shadow-xs">
        {visible.map((row) => <li key={row.user_id}><PickerRow row={row} /></li>)}
      </ul>
      {left > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-text-muted">{COPY.showing(visible.length, rows.length)}</span>
          <Button variant="outline" size="sm" onClick={onMore}>{COPY.showMore(left)}</Button>
        </div>
      ) : null}
    </div>
  );
}

function PickerRow({ row }: { row: MemberRow }) {
  const overdrawn = row.balance_minutes < 0;
  return (
    <NavLink
      to={memberHref(row.user_id)}
      data-split-item=""
      data-picker-row={row.user_id}
      className={cn(
        "no-lift relative flex min-h-touch items-center gap-3 px-3 py-2 text-sm",
        "transition-colors duration-fast ease-standard hover:bg-bg-muted motion-reduce:transition-none",
        "focus-visible:-outline-offset-2",
        // The picked row: the accent fill AND a bar on its leading edge — never colour alone.
        "before:absolute before:inset-y-1 before:left-0 before:w-1 before:rounded-full",
        "aria-[current=page]:bg-accent-soft aria-[current=page]:before:bg-accent-strong",
      )}
    >
      <Avatar size={32} aria-hidden="true">
        {row.photo_url ? <AvatarImage src={row.photo_url} alt="" /> : null}
        <AvatarFallback>{initialsOf(row.full_name)}</AvatarFallback>
      </Avatar>
      <span className="grid min-w-0 flex-1">
        <span className="truncate font-semibold text-text-primary" title={row.full_name}>{row.full_name}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          {row.membership_number ? <span className="truncate text-xs text-text-muted" title={row.membership_number}>{row.membership_number}</span> : null}
          {row.status === "Active" ? null : <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>}
        </span>
      </span>
      <span className={cn("shrink-0 text-right text-sm font-semibold tabular-nums", overdrawn ? "text-danger-strong" : "text-text-primary")}>
        <Minutes value={row.balance_minutes} />
      </span>
    </NavLink>
  );
}
