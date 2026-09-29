import { Fragment, useId, useState, type ReactNode } from "react";
import type { LedgerRow } from "@/lib/api";
import { clubDayAndClock, clubInstant } from "@/lib/clubClock";
import { cn, formatSignedCredits } from "@/lib/utils";
import { SHARE_LEDGER_COPY as COPY, shareGroupSentence, shareRowSentence } from "@/lib/walletCopy";
import { TableCell, TableRow } from "../ui/table";
import { TextLink } from "../ui/text-link";
import { CaretDown, CaretRight } from "../ui/icons";
import { CELL } from "./ledgerCells";
import { CELL_CLASS, amountInk, type Column } from "./ledgerColumns";
import { PhoneTime, ToName } from "./LedgerCellParts";
import { shareSide, type LedgerItem, type ShareSide } from "./shareGroups";
import type { ShareBooking } from "./useShareBookings";

type Group = Extract<LedgerItem, { kind: "shares" }>;

type ShareGroupRowsProps = {
  group: Group;
  columns: Column[];
  /** The booking, once read; `null` when it could not be; `undefined` while it is read. */
  booking: ShareBooking | null | undefined;
};

/** The newest movement in the group — the line's own time. */
function newest(rows: readonly LedgerRow[]): LedgerRow {
  return rows.reduce((a, b) => (new Date(b.at).getTime() > new Date(a.at).getTime() ? b : a));
}

/** Partners who have paid anything, from the booking — the "from 2 partners". */
function payingPartners(booking: ShareBooking | null | undefined): number | null {
  if (!booking) return null;
  return booking.partners.filter((p) => p.paid > 0).length;
}

/** The other person on one movement: the organiser for a partner; for the organiser, the partner who acted. */
function otherParty(row: LedgerRow, side: ShareSide, booking: ShareBooking | null | undefined): string | null {
  if (!booking) return null;
  if (side === "partner") return booking.organiserName;
  return booking.partners.find((p) => p.userId === row.actorUserId)?.name ?? null;
}

/**
 * A booking's shares as one line in the ledger, with the rows it gathers behind a disclosure.
 *
 * <p>
 * The line sits in the same columns as every other row, so it folds the same way on a phone.
 * Its words are the disclosure button (`aria-expanded`, controlling the rows beneath); the
 * booking is a separate link, because opening a list and going somewhere are two things.
 * </p>
 */
export function ShareGroupRows(props: ShareGroupRowsProps) {
  const { group, columns, booking } = props;
  const [open, setOpen] = useState(false);
  const baseId = useId();
  const side = shareSide(group);
  const sentence = shareGroupSentence({ side, net: group.net, place: booking, partners: payingPartners(booking) });
  const childIds = group.rows.map((_, i) => `${baseId}-share-${i}`);
  const head = {
    group, side, sentence, open, onToggle: () => setOpen((o) => !o), controls: childIds.join(" "),
    organiser: booking?.organiserName ?? null,
  };

  return (
    <>
      <TableRow data-share-group={group.bookingId}>
        {columns.map((column) => <Fragment key={column}>{GROUP_CELL[column](head)}</Fragment>)}
      </TableRow>
      {group.rows.map((row, i) => (
        <TableRow key={row.id} id={childIds[i]} hidden={!open} data-share-row="" className="bg-bg-muted/40">
          {columns.map((column) => (
            <Fragment key={column}>
              {CELL[column](row, column === "comment" ? shareRowSentence({ side, signed: row.signedAmountCredits, place: booking, other: otherParty(row, side, booking) }) : undefined)}
            </Fragment>
          ))}
        </TableRow>
      ))}
    </>
  );
}

type Head = {
  group: Group; side: ShareSide; sentence: string; open: boolean; onToggle: () => void; controls: string;
  /** The booking's organiser, once read — the partner line's To (D10). */
  organiser: string | null;
};

/** "Olivia Newton (organiser)" — or "Organiser" while the booking is read, or when it cannot be. */
function partnerTo(organiser: string | null): string {
  return organiser ? COPY.organiserNamed(organiser) : COPY.organiser;
}

const GROUP_CELL: Record<Column, (h: Head) => ReactNode> = {
  time: (h) => {
    const at = newest(h.group.rows).at;
    return <TableCell className={CELL_CLASS.time} title={clubInstant(at)}>{clubDayAndClock(at)}</TableCell>;
  },
  from: (h) => {
    const name = h.side === "organiser" ? COPY.partners : h.group.rows[0].subjectName;
    return <TableCell className={CELL_CLASS.from} title={name}>{name}</TableCell>;
  },
  to: (h) => (
    <TableCell className={CELL_CLASS.to}>
      <ToName name={h.side === "organiser" ? h.group.rows[0].subjectName : partnerTo(h.organiser)} />
    </TableCell>
  ),
  comment: (h) => <GroupComment head={h} />,
  amount: (h) => (
    <TableCell className={cn(CELL_CLASS.amount, amountInk(h.group.net))}>
      {formatSignedCredits(h.group.net)}
      <span className="block text-xs font-normal text-text-muted sm:hidden">{COPY.movements(h.group.rows.length)}</span>
    </TableCell>
  ),
};

function GroupComment({ head }: { head: Head }) {
  const Caret = head.open ? CaretDown : CaretRight;
  return (
    // Never truncated: it is the line's whole meaning, and the disclosure is its name.
    <TableCell className="break-words align-top text-sm text-text-primary sm:max-w-sm">
      <button
        type="button"
        aria-expanded={head.open}
        aria-controls={head.controls}
        onClick={head.onToggle}
        className={cn(
          "no-lift -mx-1 inline-flex min-h-touch items-start gap-1.5 rounded-md px-1 py-2 text-left font-semibold text-text-primary",
          "transition-colors duration-fast ease-standard hover:text-accent-strong motion-reduce:transition-none",
        )}
      >
        <Caret size={16} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0 text-text-secondary" />
        <span className="min-w-0 break-words">{head.sentence}</span>
        <span className="sr-only">{`, ${COPY.movements(head.group.rows.length)}`}</span>
      </button>
      <span className="block">
        <TextLink to={`/bookings/${head.group.bookingId}`} className="inline-flex min-h-touch items-center text-sm">
          {COPY.viewBooking}
          <span className="sr-only">{`: ${head.sentence}`}</span>
        </TextLink>
      </span>
      <PhoneTime at={newest(head.group.rows).at} />
    </TableCell>
  );
}
