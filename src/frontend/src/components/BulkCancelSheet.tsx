import { useEffect, useMemo, useState } from "react";
import { Button, Label, fieldClassName } from "./Button";
import { ConfirmButton } from "./ConfirmButton";
import { BulkResultList, BulkResultActions } from "./BulkResultList";
import { endpoints, type CancellationQuote, type ScheduleDay, type ScheduleSlot } from "../lib/api";
import { clubClock } from "../lib/clubClock";
import { formatCredits } from "../lib/utils";
import { describeFailure } from "../lib/errors";
import { readCancelResults, summariseCancel, type BulkRow } from "../lib/bulkResults";
import { cancelConsequence, cancelTotalsSentence, NO_UNDO_LINE, bulkProgress } from "../lib/bulkCopy";

type Target = { bookingId: string; slot: ScheduleSlot; courtName: string };

/**
 * Cancelling many — item 5.
 *
 * <p>
 * One screen, no wizard, because there is one decision. <b>The refund is stated per booking
 * and in total BEFORE the button</b>, and it is fetched rather than guessed:
 * `cancellationQuote` already exists and is called once per selected booking, in parallel,
 * while the sheet opens. Until they land each row shows a skeleton and the total says
 * "Working out what goes back…" — never a zero, because a zero that later becomes 270.00 is
 * a number an admin may have already acted on.
 * </p>
 *
 * <p>
 * <b>There is no Undo</b>, and the sheet says so before the fact rather than offering a magic
 * word after it (D3 §4.6): a refund is already a ledger row, and "undoing" it would mean
 * re-booking at today's price into a slot somebody else may have taken, posting a second pair
 * of movements to explain.
 * </p>
 */
export function BulkCancelSheet({ day, targets, onClose, onSettled }: {
  day: ScheduleDay;
  targets: Target[];
  onClose: () => void;
  onSettled: (doneBookingIds: string[]) => void;
}) {
  const [quotes, setQuotes] = useState<Map<string, CancellationQuote> | null>(null);
  const [waive, setWaive] = useState(false);
  const [reason, setReason] = useState("");
  const [rows, setRows] = useState<BulkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useMemo(() => newKey("bc"), []);

  useEffect(() => {
    let live = true;
    // Swallowed per booking, not per batch: one quote that will not load must not blank the
    // other eleven. A row with no quote says so rather than claiming a refund of nothing.
    Promise.all(targets.map((t) =>
      endpoints.cancellationQuote(t.bookingId).then((q) => [t.bookingId, q] as const).catch(() => null)))
      .then((pairs) => {
        if (!live) return;
        setQuotes(new Map(pairs.filter((p): p is readonly [string, CancellationQuote] => p !== null)));
      });
    return () => { live = false; };
  }, [targets]);

  const totals = useMemo(() => quoteTotals(targets, quotes), [targets, quotes]);
  const members = new Set(targets.map((t) => t.slot.ownerFirstName ?? t.slot.bookingId)).size;

  async function run() {
    setError(null);
    try {
      const res = await endpoints.adminBulkCancel({
        idempotencyKey, reason: reason.trim(), waivePenalty: waive,
        items: targets.map((t) => ({ bookingId: t.bookingId })),
      });
      const read = readCancelResults(res);
      setRows(read);
      onSettled(read.filter((r) => r.ok).map((r) => r.id));
    } catch (err) {
      setError(describeFailure(err, { action: "cancel those bookings" }));
    }
  }

  if (rows) {
    const done = summariseCancel(rows);
    return (
      <div className="space-y-3">
        <p className="text-sm">{cancelTotalsSentence(done)}</p>
        <BulkResultList rows={rows} mode="cancel" payerName={null} timezone={day.timezone}
          actions={<BulkResultActions onDone={onClose} />} />
      </div>
    );
  }

  const waitingForQuotes = quotes === null;
  return (
    <div className="space-y-4">
      <ul className="divide-y divide-border rounded-lg border border-border text-sm">
        {targets.map((t) => (
          <li key={t.bookingId} className="flex flex-wrap items-baseline gap-x-2 p-2">
            <span className="font-medium">{clubClock(t.slot.startsAtUtc, day.timezone)}</span>
            <span>{t.courtName}</span>
            <span className="text-text-secondary">{t.slot.blockLabel ?? t.slot.ownerFirstName ?? (t.slot.isMine ? "Yours" : "Reserved")}</span>
            <span className="ml-auto text-text-secondary">{quoteLine(quotes?.get(t.bookingId), t.slot)}</span>
          </li>
        ))}
      </ul>

      <p className="text-sm font-medium">
        {waitingForQuotes ? "Working out what goes back…" : cancelTotalsSentence(totals)}
      </p>

      <div className="space-y-2">
        <label className="flex items-start gap-2 text-sm min-h-11">
          <input type="checkbox" checked={waive} onChange={(e) => setWaive(e.target.checked)} className="mt-1" />
          <span>Waive the late-cancellation penalties</span>
        </label>
        <div>
          {/* Always required: D2 §5.5 bounds `reason` at 1..512, and `feature-spec.md` §7 needs a
              waiver logged WITH its reason. It also goes in the email each member gets. */}
          <Label htmlFor="bulk-cancel-reason">Tell them why</Label>
          <textarea id="bulk-cancel-reason" rows={2} value={reason} maxLength={512}
            onChange={(e) => setReason(e.target.value)} className={fieldClassName}
            placeholder="Court 1 lights faulty" />
          <p className="text-xs text-text-secondary mt-1">This goes in the email each member gets. They will read it.</p>
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-danger-strong">{error}</p>}
      <p className="text-sm text-text-secondary">{NO_UNDO_LINE}</p>
      <p className="text-sm font-medium">{cancelConsequence(totals.refundCredits - totals.penaltyCredits, members)}</p>

      <div className="flex flex-wrap gap-2 justify-end">
        <Button variant="ghost" onClick={onClose}>Keep them</Button>
        <ConfirmButton
          tone="danger"
          disabled={reason.trim().length === 0 || waitingForQuotes}
          idleLabel={waitingForQuotes ? bulkProgress("cancel", targets.length) : `Cancel ${targets.length} ${targets.length === 1 ? "booking" : "bookings"}`}
          confirmLabel="Tap to confirm"
          onConfirm={run}
        />
      </div>
    </div>
  );
}

function quoteLine(quote: CancellationQuote | undefined, slot: ScheduleSlot): string {
  if (!quote) return slot.status === "adminblock" ? "a club hold — no money moves" : "…";
  if (quote.checkedIn) return "nothing back — already checked in";
  const net = quote.refundCredits - quote.penaltyCredits;
  return quote.penaltyCredits > 0
    ? `${formatCredits(net)} back, ${formatCredits(quote.penaltyCredits)} penalty`
    : `${formatCredits(net)} back`;
}

function quoteTotals(targets: Target[], quotes: Map<string, CancellationQuote> | null) {
  let refundCredits = 0; let penaltyCredits = 0; let nothingBack = 0;
  for (const t of targets) {
    const q = quotes?.get(t.bookingId);
    if (!q) continue;
    refundCredits += q.refundCredits;
    penaltyCredits += q.penaltyCredits;
    if (q.refundCredits - q.penaltyCredits <= 0) nothingBack += 1;
  }
  return { succeeded: 0, failed: 0, refundCredits, penaltyCredits, nothingBack };
}

/**
 * One key per intended batch (D2 §5.4).
 *
 * <p>
 * Mandatory on the wire, and the retry is the point: a batch retried under the SAME key posts
 * no second refund, because the filtered unique index on `ledger_entries.ExternalReference`
 * refuses the second debit. A key regenerated on every attempt would defeat exactly that.
 * </p>
 */
export function newKey(prefix: string): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${random}`;
}
