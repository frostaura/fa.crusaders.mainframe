import { useCallback, useEffect, useMemo, useState } from "react";
import { endpoints, type ScheduleDay } from "../lib/api";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { useToast } from "../components/Toast";
import { useAuth } from "../lib/auth";
import { useBalance } from "../lib/balance";
import { cn, formatCredits } from "../lib/utils";
import { cancellationOutcome, describeBookingError } from "../lib/bookingErrors";
import { BookingConfirmModal, type AdminOption, type BookingIntent } from "../components/BookingConfirmModal";
import { CancelBookingModal } from "../components/CancelBookingModal";
import { SlotCell } from "../components/ScheduleCells";
import {
  buildTimeSlices, groupSlotsByCourt, isSlotHead, slotAt, type TimeSlice,
} from "../lib/scheduleGrid";

const ymd = (d: Date) => d.toISOString().slice(0, 10);

type CancelTarget = { bookingId: string; courtName: string; whenLabel: string; mine: boolean };

export default function SchedulePage() {
  const auth = useAuth();
  const toast = useToast();
  const { balance, refresh: refreshBalance } = useBalance();
  const isAdmin = auth.status === "authenticated" && auth.isAdmin;

  const today = useMemo(() => ymd(new Date()), []);
  const [date, setDate] = useState(today);
  const [day, setDay] = useState<ScheduleDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [booking, setBooking] = useState<BookingIntent | null>(null);
  const [cancelling, setCancelling] = useState<CancelTarget | null>(null);
  const [members, setMembers] = useState<{ userId: string; name: string }[]>([]);
  // Snapshot of "now", taken when the schedule loads, so past-slot styling is pure at render time.
  const [loadedAt, setLoadedAt] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDay(await endpoints.schedule(date));
      setLoadedAt(Date.now());
    }
    catch { setError("Couldn't load the schedule. Check your connection and press Refresh."); }
    finally { setLoading(false); }
  }, [date]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { load(); }, [load]);

  // The member picker for "book on behalf". Admin-only and loaded once — a member never
  // asks for it, and asking would be a 403 on every schedule visit.
  useEffect(() => {
    if (!isAdmin) return;
    let live = true;
    endpoints.adminMembers("Active")
      .then((rows) => { if (live) setMembers(rows.map((m) => ({ userId: m.user_id, name: m.full_name }))); })
      .catch(() => { /* the picker is unavailable; booking for oneself still works */ });
    return () => { live = false; };
  }, [isAdmin]);

  const slotsByCourt = useMemo(() => groupSlotsByCourt(day), [day]);
  const timeSlices = useMemo(() => (day ? buildTimeSlices(day) : []), [day]);

  const dateBounds = useMemo(() => {
    const span = day?.advanceBookingDays ?? 14;
    const back = new Date();
    const forward = new Date();
    // §5 "Date picker lets the player navigate ±N days". `min` was pinned to today for
    // everyone but an admin, so a member could only ever move forward — and with no
    // bookings list anywhere else in the product, there was no way to look at a booking
    // they had already played. Past days are read-only: every slot on them renders as
    // Past and none of them is bookable.
    back.setDate(back.getDate() - span);
    forward.setDate(forward.getDate() + span);
    return { min: isAdmin ? undefined : ymd(back), max: isAdmin ? undefined : ymd(forward) };
  }, [isAdmin, day?.advanceBookingDays]);

  const whenLabel = useCallback(
    (utc: string) => formatTime(utc, day?.timezone ?? "UTC"), [day?.timezone]);

  const confirmBooking = async (option: AdminOption) => {
    if (!booking) return;
    try {
      if (option.kind === "block") {
        await endpoints.adminBlock(booking.courtId, booking.startsAtUtc, 1, option.label);
        toast.push({ tone: "success", text: `${booking.courtName} held for "${option.label}" at ${booking.whenLabel}.` });
      } else if (option.kind === "member") {
        await endpoints.adminBook(booking.courtId, option.userId, booking.startsAtUtc, 1);
        toast.push({ tone: "success", text: `Booked ${booking.courtName} at ${booking.whenLabel} for that member.` });
      } else {
        await endpoints.book(booking.courtId, booking.startsAtUtc, 1);
        toast.push({ tone: "success", text: `Booked ${booking.courtName} at ${booking.whenLabel}.` });
      }
      setBooking(null);
      await Promise.all([load(), refreshBalance()]);
    } catch (err) {
      toast.push({ tone: "danger", text: describeBookingError(err, "Couldn't make that booking. Refresh the schedule and try again.") });
    }
  };

  const confirmCancel = async (waivePenalty: boolean) => {
    if (!cancelling) return;
    try {
      const result = cancelling.mine
        ? await endpoints.cancelBooking(cancelling.bookingId)
        : await endpoints.adminCancelBooking(cancelling.bookingId, waivePenalty);
      setCancelling(null);
      // The figures the server actually moved, not "refund pending" — which was shown
      // identically whether 50.00 came back, 35.00 came back, or nothing did.
      toast.push({ tone: "success", text: cancellationOutcome(result.refunded_credits, result.penalty_credits) });
      await Promise.all([load(), refreshBalance()]);
    } catch (err) {
      toast.push({ tone: "danger", text: describeBookingError(err, "Couldn't cancel that booking. Refresh the schedule and try again.") });
    }
  };

  const liftBlock = async (blockId: string) => {
    try {
      await endpoints.adminUnblock(blockId);
      toast.push({ tone: "success", text: "Block lifted — the court is free again." });
      await load();
    } catch (err) {
      toast.push({ tone: "danger", text: describeBookingError(err, "Couldn't lift that block.") });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input
          type="date"
          aria-label="Schedule date"
          value={date}
          min={dateBounds.min}
          max={dateBounds.max}
          onChange={(e) => setDate(e.target.value)}
          className="h-11 px-3 rounded-lg border border-border bg-bg-surface"
        />
        <Button variant="ghost" onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</Button>
        <span className="ml-auto text-sm font-medium text-text-secondary">{formatDayOfWeek(date)}</span>
      </div>

      {error && <Card><p className="text-sm text-danger-strong">{error}</p></Card>}

      {day && (
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
              {timeSlices.map((t, rowIndex) => {
                const cellStartMs = new Date(t.utc).getTime();
                const isPast = cellStartMs < loadedAt;
                return (
                  <RowFragment key={t.utc} t={t}>
                    {day.courts.map((c) => (
                      <SlotCell
                        key={c.id + t.utc}
                        slot={slotAt(slotsByCourt, c.id, cellStartMs, day.sliceMinutes)}
                        isHead={(s) => isSlotHead(s, cellStartMs, day.sliceMinutes, rowIndex === 0)}
                        isPast={isPast}
                        outOfHours={t.outOfHours}
                        isAdmin={isAdmin}
                        priceCredits={c.slicePriceCredits}
                        onBook={() => setBooking({
                          courtId: c.id,
                          courtName: c.name,
                          startsAtUtc: t.utc,
                          whenLabel: whenLabel(t.utc),
                          sliceMinutes: day.sliceMinutes,
                          priceCredits: c.slicePriceCredits,
                        })}
                        onCancel={(slot) => setCancelling({
                          bookingId: slot.bookingId!,
                          courtName: c.name,
                          whenLabel: whenLabel(slot.startsAtUtc),
                          mine: slot.isMine,
                        })}
                        onLiftBlock={liftBlock}
                      />
                    ))}
                  </RowFragment>
                );
              })}
            </div>
          </div>
        </Card>
      )}

      {booking && (
        <BookingConfirmModal
          intent={booking}
          balanceCredits={balance}
          members={members}
          isAdmin={isAdmin}
          onCancel={() => setBooking(null)}
          onConfirm={confirmBooking}
        />
      )}

      {cancelling && (
        <CancelBookingModal
          bookingId={cancelling.bookingId}
          courtName={cancelling.courtName}
          whenLabel={cancelling.whenLabel}
          asAdmin={isAdmin && !cancelling.mine}
          onClose={() => setCancelling(null)}
          onConfirm={confirmCancel}
        />
      )}
    </div>
  );
}

function RowFragment({ t, children }: { t: TimeSlice; children: React.ReactNode }) {
  // `cn`, not a template literal. lizard's .tsx parser reads a bare `<` inside an
  // interpolation as the start of a JSX tag, never finds its close, and swallows the
  // rest of the file into this one function — `make complexity` then reports
  // RowFragment at 153 NLOC and 43 CCN and points at a line nobody touched.
  return (
    <>
      <div className={cn(
        "sticky left-0 z-10 bg-bg-surface text-xs font-mono border-r border-border flex items-center justify-end pr-2",
        t.outOfHours ? "text-text-muted/50" : "text-text-muted",
      )}>
        {t.label}
      </div>
      {children}
    </>
  );
}

function formatDayOfWeek(ymdDate: string): string {
  const [y, m, d] = ymdDate.split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(new Date(y, m - 1, d));
}

function formatTime(utc: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", weekday: "short", day: "2-digit", month: "short",
  }).format(new Date(utc));
}
