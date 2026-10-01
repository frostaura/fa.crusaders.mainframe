import type { ReactNode } from "react";
import type { LedgerRow } from "@/lib/api";
import { clubDayAndClock, clubInstant } from "@/lib/clubClock";
import { cn, formatSignedCredits } from "@/lib/utils";
import { TableCell } from "../ui/table";
import { CELL_CLASS, amountInk, type Column } from "./ledgerColumns";
import { PhoneTime, ToName } from "./LedgerCellParts";
import { ledgerCategory, ledgerDoneBy } from "@/lib/ledgerCopy";

/**
 * One renderer per column, so the order is the caller's `columns` and nothing else.
 *
 * <p>
 * <b>Time — the club's day, in the club's format.</b> This column used to go through the
 * reader-locale helper in `lib/utils` — the READER's locale and zone — and one member journey
 * read `23:15` on the grid, `Mon, Sep 21, 11:15 PM` in the toast and `9/21/26, 8:31 PM` here.
 * `lib/clubClock` is `en-GB`, 24-hour, in the club's zone; the `title` carries the long form.
 * On a phone the column folds away and the time rides under the comment instead.
 * </p>
 *
 * <p>
 * `note` replaces the comment's words — a share row says who its credits moved to rather than
 * the server's generic "Share of a split booking".
 * </p>
 */
export const CELL: Record<Column, (r: LedgerRow, note?: string) => ReactNode> = {
  time: (r) => (
    <TableCell className={CELL_CLASS.time} title={clubInstant(r.at)}>
      {clubDayAndClock(r.at)}
    </TableCell>
  ),
  from: (r) => <TableCell className={CELL_CLASS.from} title={r.from}>{r.from}</TableCell>,
  to: (r) => <TableCell className={CELL_CLASS.to}><ToName name={r.to} /></TableCell>,
  // Wraps on a phone — it is the only column that says what a movement WAS, and for a top-up
  // the only place the rand amount and the rate appear — and truncates with a tooltip from
  // `sm`, where there is room for a column. Primary ink on a phone, where it leads the row.
  comment: (r, note) => (
    <TableCell className={CELL_CLASS.comment} title={note ?? r.comment}>
      {note ?? r.comment}
      <PhoneTime at={r.at} />
    </TableCell>
  ),
  category: (r) => <TableCell className={CELL_CLASS.category}>{ledgerCategory(r)}</TableCell>,
  actor: (r) => {
    const who = ledgerDoneBy(r);
    return <TableCell className={CELL_CLASS.actor} title={who}>{who}</TableCell>;
  },
  amount: (r) => {
    const credit = r.signedAmountCredits >= 0;
    return (
      <TableCell className={cn(CELL_CLASS.amount, amountInk(r.signedAmountCredits))}>
        {formatSignedCredits(r.signedAmountCredits)}
        {/* On a phone the From/To columns are hidden, so the counterparty rides under the
            amount rather than being lost — picked by sign, because the member is the other end.
            R4 form factor: it WRAPS (the amount's cell is nowrap, and a long name such as
            "Dispute Partner Organiser" held the column wide and squeezed the movement beside it). */}
        <span className="block whitespace-normal break-words text-xs font-normal text-text-muted sm:hidden">{credit ? r.from : r.to}</span>
      </TableCell>
    );
  },
};
