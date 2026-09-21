import { useMemo, useState } from "react";
import { Button, Label, fieldClassName } from "./Button";
import { BulkResultList, BulkResultActions } from "./BulkResultList";
import { newKey } from "./BulkCancelSheet";
import { endpoints, type ScheduleDay } from "../lib/api";
import { clubClock } from "../lib/clubClock";
import { formatCredits } from "../lib/utils";
import { describeFailure } from "../lib/errors";
import { readBookResults, summariseBook, type BulkRow } from "../lib/bulkResults";
import { bookMoneyLine, guestMoneyLine, haltSentence, RETRY_OVERDRAWN_LABEL } from "../lib/bulkCopy";
import type { MemberOption } from "../pages/Schedule";

export type BulkSlot = { courtId: string; courtName: string; startsAtUtc: string; priceCredits: number };

/** Who the batch is for. The three shapes D2 §5.3 resolves `on_behalf` into. */
type Who =
  | { kind: "self" }
  | { kind: "member"; userId: string }
  | { kind: "guest"; name: string };

/**
 * Booking many — item 13.
 *
 * <p>
 * Two steps, because there are two decisions: <b>who is this for</b>, and <b>is this the
 * money you meant</b>. The written-in name is reached without changing mode — it is a third
 * radio beside "Me" and "A member", and the sheet says in those words that nobody is charged
 * for it, because on the wire it becomes an `AdminBlock`: a guest has no wallet, no email and
 * no cancellation rights, which is exactly what a block already is.
 * </p>
 *
 * <p>
 * <b>`insufficient_balance` halts the batch, and the retry is offered with the figures.</b>
 * Every other refusal is per-item and the loop continues; a payer who runs out of credit
 * mid-batch is different, because continuing produces a jagged half-booked league night. The
 * retry goes out under the SAME idempotency key, so the items that landed answer `duplicate`
 * rather than being booked and charged twice.
 * </p>
 */
export function BulkBookSheet({ day, slots, members, actorUserId, onClose, onSettled }: {
  day: ScheduleDay;
  slots: BulkSlot[];
  members: MemberOption[];
  actorUserId: string | null;
  onClose: () => void;
  onSettled: (doneKeys: string[]) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [who, setWho] = useState<Who>({ kind: "self" });
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<BulkRow[] | null>(null);
  const [totals, setTotals] = useState<ReturnType<typeof summariseBook> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useMemo(() => newKey("bb"), []);

  const payer = who.kind === "member" ? members.find((m) => m.userId === who.userId) ?? null : null;
  const total = slots.reduce((n, s) => n + s.priceCredits, 0);

  async function run(allowNegativeBalance: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await endpoints.adminBulkBook({
        idempotencyKey,
        onBehalf: onBehalfOf(who),
        allowNegativeBalance,
        note: note.trim() || undefined,
        items: slots.map((s) => ({ courtId: s.courtId, startsAt: s.startsAtUtc, sliceCount: 1 })),
      });
      const read = readBookResults(res);
      setRows(read);
      setTotals(summariseBook(read, res));
      // Only the items that landed leave the selection — the ones that failed stay ticked, so
      // a retry does not mean re-finding six cells on a grid.
      onSettled(read.map((r, i) => (r.ok ? keyOf(slots[Number(r.id) || i]) : "")).filter(Boolean));
    } catch (err) {
      setError(describeFailure(err, { action: "make those bookings" }));
    } finally { setBusy(false); }
  }

  if (rows && totals) {
    const halt = haltSentence(totals.haltedReason, payer?.name ?? null);
    return (
      <div className="space-y-3">
        {halt && <p className="text-sm text-warning-strong">{halt}</p>}
        <BulkResultList rows={rows} mode="book" payerName={payer?.name ?? null} timezone={day.timezone}
          actions={
            <BulkResultActions
              onDone={onClose}
              busy={busy}
              retryLabel={totals.haltedReason === "insufficient_balance" ? RETRY_OVERDRAWN_LABEL : null}
              onRetry={() => { setRows(null); setTotals(null); void run(true); }}
            />
          } />
      </div>
    );
  }

  if (step === 1) {
    return (
      <div className="space-y-4">
        <WhoPicker who={who} members={members} actorUserId={actorUserId} onChange={setWho} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!isComplete(who)} onClick={() => setStep(2)}>Next</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-border rounded-lg border border-border text-sm">
        {slots.map((s) => (
          <li key={keyOf(s)} className="flex items-baseline gap-2 p-2">
            <span className="font-medium">{clubClock(s.startsAtUtc, day.timezone)}</span>
            <span>{s.courtName}</span>
            <span className="ml-auto text-text-secondary">{formatCredits(s.priceCredits)}</span>
          </li>
        ))}
      </ul>

      {/* The money, stated before anything happens — and the guest path says nobody is charged
          rather than showing a total of zero, which reads as a bug. */}
      <p className="text-sm font-medium">
        {who.kind === "guest"
          ? guestMoneyLine(slots.length)
          : bookMoneyLine(total, payer?.name ?? null, payer?.balanceCredits ?? null,
            payer?.balanceCredits !== null && payer?.balanceCredits !== undefined ? payer.balanceCredits - total : null)}
      </p>

      <div>
        <Label htmlFor="bulk-book-note">Note (optional)</Label>
        <input id="bulk-book-note" value={note} maxLength={128} onChange={(e) => setNote(e.target.value)}
          className={fieldClassName} placeholder="Div 1 play-off" />
        <p className="text-xs text-text-secondary mt-1">Admins see this on the grid. Members do not.</p>
      </div>

      {error && <p role="alert" className="text-sm text-danger-strong">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
        <Button variant="primary" loading={busy} onClick={() => run(false)}>
          Book {slots.length} {slots.length === 1 ? "slot" : "slots"}
        </Button>
      </div>
    </div>
  );
}

/** Step 1 — three choices, each with one line of consequence under it. */
function WhoPicker({ who, members, actorUserId, onChange }: {
  who: Who; members: MemberOption[]; actorUserId: string | null; onChange: (w: Who) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium mb-2">Who is this for?</legend>
      <Choice checked={who.kind === "self"} onSelect={() => onChange({ kind: "self" })}
        title="Me" hint="Booked in your own name, and it comes off your wallet." />
      <Choice checked={who.kind === "member"} onSelect={() => onChange({ kind: "member", userId: "" })}
        title="A member" hint="Charged to the member you pick.">
        <select className={fieldClassName} aria-label="Member to book for"
          value={who.kind === "member" ? who.userId : ""}
          onChange={(e) => onChange({ kind: "member", userId: e.target.value })}>
          <option value="">Choose a member…</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}{m.userId === actorUserId ? " (you)" : ""}
              {m.balanceCredits !== null ? ` — ${formatCredits(m.balanceCredits)}` : ""}
            </option>
          ))}
        </select>
      </Choice>
      <Choice checked={who.kind === "guest"} onSelect={() => onChange({ kind: "guest", name: "" })}
        title="A written-in name" hint="For a visitor or a guest. Nobody is charged and the name shows on the grid.">
        <input className={fieldClassName} aria-label="Written-in name" maxLength={128}
          value={who.kind === "guest" ? who.name : ""}
          onChange={(e) => onChange({ kind: "guest", name: e.target.value })}
          placeholder="e.g. Sarah from Westville" />
      </Choice>
    </fieldset>
  );
}

function Choice({ checked, onSelect, title, hint, children }: {
  checked: boolean; onSelect: () => void; title: string; hint: string; children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border p-2">
      <label className="flex items-start gap-2 min-h-11">
        <input type="radio" name="bulk-who" checked={checked} onChange={onSelect} className="mt-1.5" />
        <span>
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-xs text-text-secondary">{hint}</span>
        </span>
      </label>
      {checked && children && <div className="mt-2">{children}</div>}
    </div>
  );
}

function isComplete(who: Who): boolean {
  if (who.kind === "member") return who.userId.length > 0;
  if (who.kind === "guest") return who.name.trim().length > 0;
  return true;
}

/** D2 §5.3: omitted ⇒ the admin's own booking; `userId` ⇒ that member; `guestName` only ⇒ a hold. */
function onBehalfOf(who: Who): { userId?: string; guestName?: string } | undefined {
  if (who.kind === "member") return { userId: who.userId };
  if (who.kind === "guest") return { guestName: who.name.trim() };
  return undefined;
}

export function keyOf(slot: BulkSlot): string {
  return `free:${slot.courtId}:${slot.startsAtUtc}`;
}
