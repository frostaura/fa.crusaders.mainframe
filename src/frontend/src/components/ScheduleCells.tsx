import { memo } from "react";
import { Card } from "./Card";
import type { ScheduleDay, ScheduleSlot } from "../lib/api";
import { cn, formatCredits } from "../lib/utils";
import { isSlotHead, peakRestricted, slotAt, type TimeSlice } from "../lib/scheduleGrid";

type GridProps = {
  day: ScheduleDay;
  slotsByCourt: Map<string, ScheduleSlot[]>;
  timeSlices: TimeSlice[];
  /** "Now", frozen when the schedule loaded, so past-slot styling is pure at render time. */
  loadedAt: number;
  isAdmin: boolean;
  onBook: (courtId: string, courtName: string, startsAtUtc: string, priceCredits: number) => void;
  onCancel: (slot: ScheduleSlot, courtName: string) => void;
  onLiftBlock: (blockId: string) => void | Promise<void>;
};

/**
 * The grid itself, memoised.
 *
 * <p>
 * A club day is four courts by fifty-odd rows — a couple of hundred cells — and every one
 * of them used to re-render whenever any state on the page moved. Opening the booking
 * confirmation, closing it, arming a cancellation: each rebuilt the whole grid, for a
 * modal that does not touch a single cell. Measured at 28 ms in jsdom just to open a
 * dialog, which in a browser is the difference between a tap that lands and a tap that
 * feels like it did not.
 * </p>
 *
 * <p>
 * The memo only bites because the callbacks are stable — they take the court and the
 * instant as arguments rather than closing over them — so the page's modal state can
 * change without giving the grid a new function on every render.
 * </p>
 */
/**
 * The board itself: the sticky court headers and the grid under them, in one scroller.
 *
 * <p>
 * Here rather than in `pages/Schedule.tsx` because that page carries the schedule's entire
 * state machine — two modals, four mutations, an optimistic grid — and the complexity gate's
 * 200-line limit is what stops that growing without anyone choosing to let it. The chrome
 * around the grid holds no state, so it moves for free; `ScheduleGrid` stays memoised inside
 * it, which is what keeps opening a dialog from re-rendering two hundred cells.
 * </p>
 */
export function ScheduleBoard(props: GridProps & { day: ScheduleDay }) {
  const { day } = props;
  return (
    <Card className="p-0 overflow-hidden mb-6">
      <div className="overflow-auto max-h-[calc(100vh-220px)]">
        <div className="grid min-w-[600px]" style={{ gridTemplateColumns: `64px repeat(${day.courts.length}, minmax(120px, 1fr))` }}>
          <div className="sticky top-0 left-0 z-30 bg-bg-surface" />
          {day.courts.map((c) => (
            <div key={c.id} className="sticky top-0 z-20 bg-bg-surface px-2 py-2 text-xs text-text-secondary text-center border-b border-border">
              <div className="font-medium text-text-primary">{c.name}</div>
              <div>{formatCredits(c.slicePriceCredits)}/slice</div>
            </div>
          ))}
          <ScheduleGrid {...props} />
        </div>
      </div>
    </Card>
  );
}

export const ScheduleGrid = memo(function ScheduleGrid(props: GridProps) {
  const { day, slotsByCourt, timeSlices, loadedAt, isAdmin, onBook, onCancel, onLiftBlock } = props;
  return (
    <>
      {timeSlices.map((t, rowIndex) => {
        const cellStartMs = new Date(t.utc).getTime();
        const isPast = cellStartMs < loadedAt;
        return (
          <RowFragment key={t.utc} t={t}>
            {day.courts.map((c) => (
              <SlotCell
                key={c.id + t.utc}
                slot={slotAt(slotsByCourt, c.id, cellStartMs, day.sliceMinutes)}
                where={`${c.name} at ${t.label}`}
                isHead={(s) => isSlotHead(s, cellStartMs, day.sliceMinutes, rowIndex === 0)}
                isPast={isPast}
                outOfHours={t.outOfHours}
                leagueOnly={peakRestricted(day, t.minuteOfDay, cellStartMs, loadedAt)}
                isAdmin={isAdmin}
                priceCredits={c.slicePriceCredits}
                onBook={() => onBook(c.id, c.name, t.utc, c.slicePriceCredits)}
                onCancel={(slot) => onCancel(slot, c.name)}
                onLiftBlock={onLiftBlock}
              />
            ))}
          </RowFragment>
        );
      })}
    </>
  );
});

function RowFragment({ t, children }: { t: TimeSlice; children: React.ReactNode }) {
  // `cn`, not a template literal. lizard's .tsx parser reads a bare `<` inside an
  // interpolation as the start of a JSX tag, never finds its close, and swallows the
  // rest of the file into this one function — `make complexity` then reports it at
  // enormous NLOC and CCN and points at a line nobody touched.
  // Never a faded label. `text-text-muted` at 12px is already the worst contrast on this
  // screen (E-F08 measures it at 2.56:1 against white, where AA asks 4.5:1), and the time
  // is the ONLY thing on the grid that says what time a slot is — the court and the price
  // are column headers and the slot button carries no time at all. Fading it further to
  // mark a closed row would have made the least readable text on the page less readable
  // still; a closed row says so in its own cells instead.
  return (
    <>
      <div className={cn(
        "sticky left-0 z-10 bg-bg-surface text-xs font-mono border-r border-border",
        "flex items-center justify-end pr-2 text-text-secondary",
        t.outOfHours && "italic",
      )}>
        {t.label}
      </div>
      {children}
    </>
  );
}


/**
 * The cells of the schedule grid.
 *
 * <p>
 * Lifted out of `pages/Schedule.tsx` so neither file runs long. It is also what keeps
 * `make complexity` honest here: lizard's .tsx parser loses track inside a JSX fragment
 * and reports the whole remainder of a file as one enormous function, so a long page
 * component trips the length gate on a line nobody touched.
 * </p>
 */
type SlotCellProps = {
  slot?: ScheduleSlot;
  /**
   * "Court 1 at 06:00" — what this cell IS, carried rather than inferred.
   *
   * <p>
   * The grid conveys court and time by POSITION: a column header and a row label. Position
   * is exactly what a screen reader, or anyone tabbing, cannot perceive — so eleven
   * identically-named "Available" buttons were the same button as far as assistive tech was
   * concerned. One composed string rather than two props: no cell ever wants them apart.
   * </p>
   */
  where: string;
  isHead: (slot: ScheduleSlot) => boolean;
  isPast?: boolean;
  outOfHours?: boolean;
  /** A.12's peak window, as it applies to this viewer: reserved, not free — see `peakRestricted`. */
  leagueOnly?: boolean;
  isAdmin: boolean;
  priceCredits?: number;
  onBook: () => void;
  onCancel: (slot: ScheduleSlot) => void;
  onLiftBlock: (blockId: string) => void | Promise<void>;
};

export function SlotCell(props: SlotCellProps) {
  const { slot, isHead, isPast, outOfHours, leagueOnly, isAdmin, priceCredits, where, onBook, onCancel, onLiftBlock } = props;

  if (!slot) {
    return (
      <EmptyCell
        isPast={isPast} outOfHours={outOfHours} leagueOnly={leagueOnly}
        priceCredits={priceCredits} where={where} onBook={onBook}
      />
    );
  }

  // Only the booking's first cell carries its name and controls. Every later cell of the
  // same booking is a continuation — which is what makes a 60-minute booking read as one
  // block rather than as four identical buttons, and what stops a member from being
  // offered "cancel" four times for one thing.
  if (!isHead(slot)) return <ContinuationCell slot={slot} where={where} />;

  if (slot.status === "adminblock") {
    return (
      <div className="m-0.5 h-12 rounded-md bg-bg-muted bg-[repeating-linear-gradient(45deg,_rgba(0,0,0,0.04)_0,_rgba(0,0,0,0.04)_4px,_transparent_4px,_transparent_8px)] flex items-center justify-center gap-1 text-xs text-text-secondary px-1">
        <span className="truncate" aria-label={`${where} — ${slot.blockLabel ?? "blocked"}`}>{slot.blockLabel ?? "Blocked"}</span>
        {isAdmin && slot.bookingId && !isPast && (
          <button
            type="button"
            className="text-[10px] underline shrink-0 no-lift"
            onClick={() => onLiftBlock(slot.bookingId!)}
            aria-label={`Lift the hold on ${where}`}
          >
            lift
          </button>
        )}
      </div>
    );
  }

  if (slot.isMine) return <MyCell slot={slot} isPast={isPast} where={where} onCancel={onCancel} />;
  return <OtherCell slot={slot} isAdmin={isAdmin} isPast={isPast} where={where} onCancel={onCancel} />;
}

function EmptyCell({ isPast, outOfHours, leagueOnly, priceCredits, where, onBook }: {
  isPast?: boolean; outOfHours?: boolean; leagueOnly?: boolean;
  priceCredits?: number; where: string; onBook: () => void;
}) {
  // Closed, not merely empty. §5's `out_of_hours` — rendered and inert, so a member can
  // see that the club is shut rather than seeing a grid that stops without explanation.
  if (outOfHours) {
    return (
      <div
        className="m-0.5 h-12 rounded-md bg-bg-muted/40 border border-dashed border-border text-text-secondary flex items-center justify-center text-[11px]"
        aria-label={`${where} — the club is closed`}
      >
        Closed
      </div>
    );
  }
  if (isPast) {
    return (
      <div
        className="m-0.5 h-12 rounded-md bg-bg-muted/60 border border-border text-text-secondary flex items-center justify-center text-[11px] font-medium tracking-wide uppercase"
        aria-label={`${where} — past`}
      >
        Past
      </div>
    );
  }
  // N-F6: reserved, not free. A Regular member was shown 44 of these a day in the same green
  // as a bookable cell, with the same cursor and the same "Book … for 50.00 cr" label, and
  // found out only after reading a price and pressing Confirm. It is rendered and inert, like
  // `out_of_hours` above it — the slot exists and the member can see it is not theirs yet, and
  // it becomes an ordinary Available cell inside the advance window (§5, A.12).
  if (leagueOnly) {
    return (
      <div
        className="m-0.5 h-12 rounded-md bg-warning-soft/50 border border-dashed border-warning-strong/30 text-warning-strong flex items-center justify-center text-center text-[11px] leading-tight px-1"
        aria-label={`${where} — reserved for league and senior members until closer to the time`}
      >
        League only
      </div>
    );
  }
  // The parameter used to be called priceZar and rendered with a rand sign. The
  // name was the tell: it is a credit price, and at 1.6-2.4 credits per rand the
  // grid was quoting a court at well under half what it costs.
  const price = priceCredits !== undefined ? formatCredits(priceCredits) : "";
  return (
    <button
      type="button"
      onClick={onBook}
      aria-label={price ? `Book ${where} for ${price}` : `Book ${where}`}
      className="m-0.5 h-12 rounded-md bg-success-soft text-success-strong hover:bg-success-soft/70 text-xs font-medium"
    >
      Available
    </button>
  );
}

/** A later cell of a booking that started earlier. Reserved, and visibly the same booking. */
function ContinuationCell({ slot, where }: { slot: ScheduleSlot; where: string }) {
  const tone = slot.isMine ? "bg-info-soft/60 text-info-strong" : "bg-bg-muted text-text-secondary";
  return (
    <div className={cn("m-0.5 h-12 rounded-md flex items-center justify-center text-[11px]", tone)}
      aria-label={slot.isMine ? `${where} — continues, your booking` : `${where} — continues, reserved`}>
      ⋯
    </div>
  );
}

function MyCell({ slot, isPast, where, onCancel }: {
  slot: ScheduleSlot; isPast?: boolean; where: string; onCancel: (slot: ScheduleSlot) => void;
}) {
  // Attendance, on screen at last. The schedule projection did not carry it, so no
  // screen in the product could tell a member their court was lit — which is also why
  // the cancel affordance could not warn that nothing would come back.
  const label = slot.checkedIn ? "Mine · checked in" : "Mine";
  if (isPast || !slot.bookingId) {
    return (
      <div
        className="m-0.5 h-12 rounded-md bg-info-soft/60 text-info-strong border border-info-soft flex items-center justify-center text-xs font-medium text-center px-1"
        aria-label={slot.checkedIn ? `${where} — your past booking, attended` : `${where} — your past booking`}
      >
        {slot.checkedIn ? "Mine · played" : "Mine · past"}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onCancel(slot)}
      aria-label={slot.checkedIn
        ? `Cancel your booking on ${where} — checked in`
        : `Cancel your booking on ${where}`}
      className={cn(
        "m-0.5 h-12 rounded-md text-xs font-medium px-1 text-center",
        slot.checkedIn
          ? "bg-warning-soft text-warning-strong hover:bg-warning-soft/70"
          : "bg-info-soft text-info-strong hover:bg-info-soft/80",
      )}
    >
      {label}
    </button>
  );
}

function OtherCell({ slot, isAdmin, isPast, where, onCancel }: {
  slot: ScheduleSlot; isAdmin: boolean; isPast?: boolean; where: string; onCancel: (slot: ScheduleSlot) => void;
}) {
  // "The booking grid shows photo + name only" — no email, phone or membership number.
  const body = (
    <>
      {slot.ownerPhotoUrl ? (
        <img src={slot.ownerPhotoUrl} alt="" style={{ width: 34, height: 34 }} className="rounded-full object-cover ring-2 ring-bg-surface shadow-sm shrink-0" />
      ) : (
        <div style={{ width: 34, height: 34 }} className="rounded-full bg-bg-surface border border-border flex items-center justify-center text-sm font-medium ring-2 ring-bg-surface shadow-sm shrink-0">
          {slot.ownerFirstName?.[0] ?? "?"}
        </div>
      )}
      <span className="truncate">{slot.ownerFirstName ?? "Reserved"}</span>
      {slot.checkedIn && <span className="text-[10px] text-success-strong shrink-0">on court</span>}
    </>
  );

  // §8: an admin can cancel any booking on behalf of any member, penalty waiveable. The
  // endpoint has always existed; another member's slot was inert text with no way to
  // reach it, so a club running the desk had to go to the database.
  if (isAdmin && slot.bookingId && !isPast) {
    return (
      <button
        type="button"
        onClick={() => onCancel(slot)}
        aria-label={`${slot.ownerFirstName ?? "Reserved"} — cancel on their behalf, ${where}`}
        className="m-0.5 h-12 w-[calc(100%-0.25rem)] rounded-md bg-bg-muted text-text-secondary hover:bg-bg-muted/70 flex items-center justify-center gap-2 text-xs px-1"
      >
        {body}
      </button>
    );
  }

  return (
    <div className="m-0.5 h-12 rounded-md bg-bg-muted text-text-secondary flex items-center justify-center gap-2 text-xs overflow-visible px-1"
      aria-label={`${where} — booked by ${slot.ownerFirstName ?? "another member"}`}>
      {body}
    </div>
  );
}
