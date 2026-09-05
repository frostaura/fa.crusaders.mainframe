import { useState } from "react";
import { Modal } from "./Modal";
import { Button, Label } from "./Button";
import { formatCredits } from "../lib/utils";

export type BookingIntent = {
  courtId: string;
  courtName: string;
  startsAtUtc: string;
  /** Wall-clock label in the tenant's timezone, e.g. "Sat, 05 Sep, 14:00". */
  whenLabel: string;
  sliceMinutes: number;
  priceCredits: number;
};

/** What the admin can do here that a member cannot: book it for someone else, or block it. */
export type AdminOption =
  | { kind: "self" }
  | {
      kind: "member";
      userId: string;
      /**
       * §8's override, asked for by name after the club has seen the refusal. Absent or
       * false on the first attempt, always — the desk is shown what the overdraft would
       * cost the member before it can send this.
       */
      allowNegativeBalance?: boolean;
    }
  | { kind: "block"; label: string };

/**
 * What the page did with a confirmation.
 *
 * <p>
 * `short` is §8's case and the only reason this is not `Promise&lt;void&gt;`: the member
 * being booked for cannot cover the court, and the decision about whether to overdraw them
 * belongs to the admin looking at the figures — so the refusal has to come back INTO the
 * modal rather than leaving as a toast. Every other outcome, success or refusal, is `done`
 * and has already been reported by the page.
 * </p>
 */
export type BookingOutcome =
  | { kind: "done" }
  | { kind: "short"; currentCredits: number; requiredCredits: number };

type Props = {
  intent: BookingIntent;
  balanceCredits: number | null;
  /** Members to offer when an admin books on behalf. Empty for a member. */
  members: { userId: string; name: string }[];
  isAdmin: boolean;
  onCancel: () => void;
  onConfirm: (option: AdminOption) => Promise<BookingOutcome>;
};

/**
 * §5: "Tap an `available` slot → confirmation modal showing court, time, duration,
 * cost, current balance, balance after."
 *
 * <p>
 * None of that existed. The confirmation was the grid cell itself turning orange and
 * relabelling to "Reserve for 50.00 cr?" — no court, no time, no duration, no balance —
 * and it disarmed after three seconds, so a member who stopped to read the price tapped
 * a control that had already gone back to idle and nothing happened at all. There was
 * no way for a slow reader to book.
 * </p>
 *
 * <p>
 * This modal has no timer. It closes when the member confirms or dismisses it, and it
 * shows the balance they will be left with, which is the number they actually want
 * before agreeing to spend.
 * </p>
 */
export function BookingConfirmModal({ intent, balanceCredits, members, isAdmin, onCancel, onConfirm }: Props) {
  const [mode, setMode] = useState<Mode>("self");
  const [memberId, setMemberId] = useState("");
  const [blockLabel, setBlockLabel] = useState("Tournament");
  const [busy, setBusy] = useState(false);
  // The server's answer to the first attempt, when the member turned out to be short.
  // Held here rather than on the page because it is the reason the modal is still open.
  const [shortfall, setShortfall] = useState<{ current: number; required: number } | null>(null);

  // Any change of who or what is being booked invalidates the figures above — they belong
  // to one member and one attempt. Cleared in the setters rather than in an effect so
  // there is no frame in which last member's shortfall is displayed against this one.
  const changeMode = (next: Mode) => { setShortfall(null); setMode(next); };
  const changeMember = (next: string) => { setShortfall(null); setMemberId(next); };

  const free = mode === "block";
  const cost = free ? 0 : intent.priceCredits;
  const chargedToSomeoneElse = mode === "member";
  // Affordability follows WHOEVER IS BEING CHARGED, which is not always the person
  // looking at the screen.
  //
  // This read `free || balanceCredits === null || balanceCredits >= cost` — the
  // signed-in viewer's balance, in every mode — so an admin booking on a member's
  // behalf was refused out of the ADMIN's wallet. A desk account is never topped up
  // because it never plays, so its balance is 0 and the third of §8's three admin
  // actions was unreachable from the moment it shipped: the modal read "charged to the
  // member" and "that's more than you have" in the same breath, with the button
  // disabled. The other two (cancel on a member's behalf, block a court) worked, which
  // is why it looked whole.
  //
  // A block is free and a member booking spends the member's credit — and §8 lets an
  // admin push that member into a negative balance deliberately. Neither is the
  // viewer's money, so neither is the viewer's balance to fail.
  const spendingOwnCredit = !free && !chargedToSomeoneElse;
  const canAfford = !spendingOwnCredit || balanceCredits === null || balanceCredits >= cost;

  function optionFor(overrideBalance: boolean): AdminOption {
    if (mode === "member") return { kind: "member", userId: memberId, allowNegativeBalance: overrideBalance };
    if (mode === "block") return { kind: "block", label: blockLabel.trim() || "Blocked" };
    return { kind: "self" };
  }

  const submit = async (overrideBalance = false) => {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await onConfirm(optionFor(overrideBalance));
      // A short member keeps the modal open with the figures on it. Everything else has
      // already been dealt with by the page — a success unmounts this, a refusal toasts.
      setShortfall(outcome.kind === "short" ? { current: outcome.currentCredits, required: outcome.requiredCredits } : null);
    } finally {
      setBusy(false);
    }
  };

  const memberName = members.find((m) => m.userId === memberId)?.name ?? "That member";

  return (
    <Modal title="Confirm booking" onClose={onCancel}>
      <CostSummary
        intent={intent} balanceCredits={balanceCredits}
        free={free} cost={cost} chargedToSomeoneElse={chargedToSomeoneElse}
      />

      {isAdmin && (
        <AdminOptions
          mode={mode} setMode={changeMode}
          memberId={memberId} setMemberId={changeMember}
          blockLabel={blockLabel} setBlockLabel={setBlockLabel}
          members={members}
        />
      )}

      {!canAfford && (
        <p className="text-sm text-danger-strong mb-3">
          That's more than you have. Top up your wallet, then book.
        </p>
      )}

      {shortfall && <OverdraftNotice name={memberName} current={shortfall.current} required={shortfall.required} />}

      <ConfirmActions
        busy={busy} free={free} cost={cost} shortfall={shortfall}
        blocked={!canAfford || (mode === "member" && memberId === "")}
        onCancel={onCancel} onSubmit={submit}
      />
    </Modal>
  );
}

/**
 * §5's six figures: court, time, duration, cost, current balance, balance after.
 *
 * <p>
 * Split out of the modal rather than inlined because it is the only part of the dialog
 * that does not move — the admin controls, the refusal and the actions all react to what
 * the desk is doing, and this states the slot.
 * </p>
 */
function CostSummary(props: {
  intent: BookingIntent; balanceCredits: number | null;
  free: boolean; cost: number; chargedToSomeoneElse: boolean;
}) {
  const { intent, balanceCredits, free, cost, chargedToSomeoneElse } = props;
  return (
    <dl className="text-sm space-y-1.5 mb-4">
      <Row term="Court" value={intent.courtName} />
      <Row term="Time" value={intent.whenLabel} />
      <Row term="Duration" value={`${intent.sliceMinutes} min`} />
      <Row term="Cost" value={free ? "No charge — court held, not sold" : formatCredits(cost)} />
      {!free && balanceCredits !== null && (
        <>
          <Row term={chargedToSomeoneElse ? "Their balance" : "Balance now"} value={
            chargedToSomeoneElse ? "charged to the member" : formatCredits(balanceCredits)} />
          {!chargedToSomeoneElse && (
            <Row term="Balance after" value={formatCredits(balanceCredits - cost)} emphasise />
          )}
        </>
      )}
    </dl>
  );
}

/**
 * The dialog's two buttons, and the one place the §8 override is offered.
 *
 * <p>
 * The override REPLACES the ordinary confirm rather than sitting beside it, so there is no
 * frame in which a desk that has just been told a member is short can press a button
 * labelled "Book for 50.00 cr" and be surprised by what it does. It is a danger button and
 * it states, in its own label, the balance it will leave behind.
 * </p>
 */
function ConfirmActions(props: {
  busy: boolean; free: boolean; cost: number; blocked: boolean;
  shortfall: { current: number; required: number } | null;
  onCancel: () => void; onSubmit: (overrideBalance: boolean) => void;
}) {
  const { busy, free, cost, blocked, shortfall, onCancel, onSubmit } = props;
  return (
    <div className="flex gap-2 justify-end">
      <Button variant="ghost" onClick={onCancel} disabled={busy}>Keep looking</Button>
      {shortfall ? (
        <Button variant="danger" onClick={() => onSubmit(true)} disabled={busy}>
          {busy ? "Booking…" : `Book anyway — leaves ${formatCredits(shortfall.current - shortfall.required)}`}
        </Button>
      ) : (
        <Button onClick={() => onSubmit(false)} disabled={busy || blocked}>
          {busy ? "Booking…" : free ? "Block the court" : `Book for ${formatCredits(cost)}`}
        </Button>
      )}
    </div>
  );
}

/**
 * §8: "Book on behalf of any member (charges that member's credit; if insufficient, admin
 * can override and create a negative balance, logged)."
 *
 * <p>
 * The override is a second, deliberate step and this is what makes it one. The desk sends
 * an ordinary booking, the server refuses it with the member's balance and the price, and
 * only then does an override appear — labelled with the balance it will leave behind, in a
 * danger button, beside the member's own name. An admin who picked the wrong person from
 * the dropdown finds out here, from the name and the figures, rather than from an audit
 * report at month end.
 * </p>
 *
 * <p>
 * The member's balance is not on the schedule payload and is deliberately not fetched to
 * pre-empt this: the numbers that matter are the ones the server refused on, under the
 * lock that decides the booking, and any figure read earlier could be stale by the time
 * the desk presses the button.
 * </p>
 */
function OverdraftNotice({ name, current, required }: { name: string; current: number; required: number }) {
  return (
    <div className="mb-3 rounded-lg border border-danger-soft bg-danger-soft/40 p-3 text-sm">
      <p className="font-semibold text-danger-strong">
        {name} doesn't have enough credit for this court.
      </p>
      <dl className="mt-2 space-y-1">
        <Row term="Their balance" value={formatCredits(current)} />
        <Row term="This booking" value={formatCredits(required)} />
        <Row term="Their balance after" value={formatCredits(current - required)} emphasise />
      </dl>
      <p className="mt-2 text-text-secondary">
        You can book it anyway. It charges {name} the full price, leaves them owing the
        difference, and is logged against your name. They'll be emailed and asked to top up.
      </p>
    </div>
  );
}

type Mode = "self" | "member" | "block";

/**
 * §8's three admin actions, on the slot the admin is looking at: book it for themselves,
 * book it on behalf of a member, or hold it for an event.
 *
 * <p>
 * All three endpoints existed and none of them was reachable from a screen. An admin
 * looking at the schedule saw another member's slot as inert text and a free slot as a
 * control that would book it for the admin's own account — so a club running a
 * tournament had to book every court out under somebody's name, and a desk cancelling
 * for a member had to go to the database.
 * </p>
 */
function AdminOptions(props: {
  mode: Mode; setMode: (m: Mode) => void;
  memberId: string; setMemberId: (id: string) => void;
  blockLabel: string; setBlockLabel: (label: string) => void;
  members: { userId: string; name: string }[];
}) {
  const { mode, setMode, memberId, setMemberId, blockLabel, setBlockLabel, members } = props;
  const field = "w-full h-11 px-3 rounded-lg border border-border bg-bg-surface";
  return (
    <div className="mb-4 space-y-2">
      <Label htmlFor="booking-mode">Book this as</Label>
      <select id="booking-mode" value={mode} onChange={(e) => setMode(e.target.value as Mode)} className={field}>
        <option value="self">My own booking</option>
        <option value="member">On behalf of a member</option>
        <option value="block">Block the court for an event</option>
      </select>

      {mode === "member" && (
        <select aria-label="Member" value={memberId} onChange={(e) => setMemberId(e.target.value)} className={field}>
          <option value="">Choose a member…</option>
          {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
        </select>
      )}

      {mode === "block" && (
        <input
          aria-label="Block label"
          value={blockLabel}
          onChange={(e) => setBlockLabel(e.target.value)}
          placeholder="Tournament, Maintenance…"
          className={field}
        />
      )}
    </div>
  );
}

function Row({ term, value, emphasise }: { term: string; value: string; emphasise?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-text-secondary">{term}</dt>
      <dd className={emphasise ? "font-semibold text-text-primary" : "text-text-primary"}>{value}</dd>
    </div>
  );
}
