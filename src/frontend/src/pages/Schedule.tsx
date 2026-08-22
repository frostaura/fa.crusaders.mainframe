import { useEffect, useMemo, useState } from "react";
import { endpoints, type ScheduleDay, type ScheduleSlot, ApiError } from "../lib/api";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { ConfirmButton } from "../components/ConfirmButton";
import { useToast } from "../components/Toast";
import { useAuth } from "../lib/auth";
import { useBalance } from "../lib/balance";

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export default function SchedulePage() {
  const auth = useAuth();
  const toast = useToast();
  const { refresh: refreshBalance } = useBalance();
  const today = useMemo(() => ymd(new Date()), []);
  const [date, setDate] = useState(today);
  const [day, setDay] = useState<ScheduleDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Snapshot of "now", taken when the schedule loads, so past-slot styling is pure at render time.
  const [loadedAt, setLoadedAt] = useState(0);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setDay(await endpoints.schedule(date));
      setLoadedAt(Date.now());
    }
    catch { setError("Couldn't load schedule."); }
    finally { setLoading(false); }
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [date]);

  const slotsByCourtAndStart = useMemo(() => {
    if (!day) return new Map<string, ScheduleSlot>();
    const m = new Map<string, ScheduleSlot>();
    for (const s of day.slots) m.set(`${s.courtId}|${new Date(s.startsAtUtc).getTime()}`, s);
    return m;
  }, [day]);

  const timeSlices = useMemo(
    () => buildTimeSlices(date, day?.sliceMinutes ?? 30, day?.timezone ?? "UTC", day?.dayStartMinute ?? 6 * 60, day?.dayEndMinute ?? 22 * 60),
    [date, day?.sliceMinutes, day?.timezone, day?.dayStartMinute, day?.dayEndMinute],
  );

  const maxDate = useMemo(() => {
    if (auth.status === "authenticated" && auth.isAdmin) return undefined;
    const d = new Date();
    d.setDate(d.getDate() + (day?.advanceBookingDays ?? 14));
    return ymd(d);
  }, [auth, day?.advanceBookingDays]);

  const book = async (court: { id: string; name: string }, startUtc: string) => {
    try {
      await endpoints.book(court.id, startUtc, 1);
      toast.push({ tone: "success", text: `Booked ${court.name} at ${formatTime(startUtc, day?.timezone ?? "UTC")}.` });
      await Promise.all([load(), refreshBalance()]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) toast.push({ tone: "danger", text: "Insufficient balance — please top up." });
      else if (err instanceof ApiError && err.status === 409) toast.push({ tone: "danger", text: "Slot was just taken — refresh the schedule." });
      else if (err instanceof ApiError && err.status === 400) toast.push({ tone: "danger", text: "That slot is in the past." });
      else toast.push({ tone: "danger", text: "Booking failed." });
    }
  };

  const cancel = async (bookingId: string) => {
    try {
      await endpoints.cancelBooking(bookingId);
      toast.push({ tone: "success", text: "Booking cancelled — refund pending." });
      await Promise.all([load(), refreshBalance()]);
    }
    catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        toast.push({ tone: "danger", text: "That booking has already started — it can't be cancelled." });
      } else {
        toast.push({ tone: "danger", text: "Cancellation failed." });
      }
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input
          type="date"
          value={date}
          min={auth.status === "authenticated" && auth.isAdmin ? undefined : today}
          max={maxDate}
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
                  <div>R{c.slicePriceCredits.toFixed(2)}/slice</div>
                </div>
              ))}
              {timeSlices.map((t) => {
                const isPast = new Date(t.utc).getTime() < loadedAt;
                return (
                  <RowFragment key={t.utc} t={t}>
                    {day.courts.map((c) => {
                      const slot = slotsByCourtAndStart.get(`${c.id}|${new Date(t.utc).getTime()}`);
                      return <SlotCell key={c.id + t.utc} slot={slot} isPast={isPast} priceZar={c.slicePriceCredits} onBook={() => book(c, t.utc)} onCancel={(id) => cancel(id)} />;
                    })}
                  </RowFragment>
                );
              })}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function RowFragment({ t, children }: { t: TimeSlice; children: React.ReactNode }) {
  return (
    <>
      <div className="sticky left-0 z-10 bg-bg-surface text-xs text-text-muted font-mono border-r border-border flex items-center justify-end pr-2">
        {t.label}
      </div>
      {children}
    </>
  );
}

function SlotCell({ slot, isPast, priceZar, onBook, onCancel }: { slot?: ScheduleSlot; isPast?: boolean; priceZar?: number; onBook: () => void | Promise<void>; onCancel: (id: string) => void | Promise<void> }) {
  if (!slot) {
    if (isPast) {
      return (
        <div
          className="m-0.5 h-12 rounded-md bg-bg-muted/60 border border-border/40 text-text-muted/70 flex items-center justify-center text-[11px] font-medium tracking-wide uppercase"
          aria-label="Past slot"
        >
          Past
        </div>
      );
    }
    const price = priceZar !== undefined ? `R${priceZar.toFixed(0)}` : "";
    return (
      <ConfirmButton
        idleLabel="Available"
        confirmLabel={price ? `Reserve for ${price}?` : "Confirm booking"}
        onConfirm={onBook}
        idleClassName="bg-success-soft text-success-strong hover:bg-success-soft/70"
        className="m-0.5 h-12"
      />
    );
  }
  if (slot.status === "adminblock") {
    return <div className="m-0.5 h-12 rounded-md bg-bg-muted bg-[repeating-linear-gradient(45deg,_rgba(0,0,0,0.04)_0,_rgba(0,0,0,0.04)_4px,_transparent_4px,_transparent_8px)] flex items-center justify-center text-xs text-text-secondary">{slot.blockLabel ?? "Blocked"}</div>;
  }
  if (slot.isMine) {
    if (isPast) {
      return (
        <div
          className="m-0.5 h-12 rounded-md bg-info-soft/60 text-info-strong/80 border border-info-soft flex items-center justify-center text-xs font-medium"
          aria-label="Past booking"
        >
          Mine · Past
        </div>
      );
    }
    return (
      <ConfirmButton
        idleLabel="Mine"
        confirmLabel="Confirm cancel"
        onConfirm={async () => { if (slot.bookingId) await onCancel(slot.bookingId); }}
        className="m-0.5 h-12"
      />
    );
  }
  return (
    <div className="m-0.5 h-12 rounded-md bg-bg-muted text-text-secondary flex items-center justify-center gap-2 text-xs overflow-visible">
      {slot.ownerPhotoUrl ? (
        <img src={slot.ownerPhotoUrl} alt="" style={{ width: 34, height: 34 }} className="rounded-full object-cover ring-2 ring-bg-surface shadow-sm shrink-0" />
      ) : (
        <div style={{ width: 34, height: 34 }} className="rounded-full bg-bg-surface border border-border flex items-center justify-center text-sm font-medium ring-2 ring-bg-surface shadow-sm shrink-0">
          {slot.ownerFirstName?.[0] ?? "?"}
        </div>
      )}
      <span className="truncate">{slot.ownerFirstName ?? "Reserved"}</span>
    </div>
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

type TimeSlice = { utc: string; label: string };

// Returns the IANA-timezone offset (minutes) for a given UTC instant.
function tzOffsetMinutes(timezone: string, atUtcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" });
  const tzPart = dtf.formatToParts(new Date(atUtcMs)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = tzPart.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] ?? "0", 10));
}

// Builds the wall-clock slice grid in the tenant timezone, returning UTC ISO that matches API rows.
function buildTimeSlices(date: string, sliceMinutes: number, timezone: string, startMinutes: number, endMinutes: number): TimeSlice[] {
  const slices: TimeSlice[] = [];
  const [y, m, d] = date.split("-").map(Number);
  for (let mins = startMinutes; mins < endMinutes; mins += sliceMinutes) {
    const hh = Math.floor(mins / 60);
    const mm = mins % 60;
    // Treat hh:mm as wall-clock in `timezone`. Convert to UTC by subtracting the tz offset at that instant.
    const naiveUtcMs = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
    const offset = tzOffsetMinutes(timezone, naiveUtcMs);
    const utc = new Date(naiveUtcMs - offset * 60_000).toISOString();
    const label = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    slices.push({ utc, label });
  }
  return slices;
}
