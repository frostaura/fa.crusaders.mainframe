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
  | { kind: "member"; userId: string }
  | { kind: "block"; label: string };

type Props = {
  intent: BookingIntent;
  balanceCredits: number | null;
  /** Members to offer when an admin books on behalf. Empty for a member. */
  members: { userId: string; name: string }[];
  isAdmin: boolean;
  onCancel: () => void;
  onConfirm: (option: AdminOption) => Promise<void>;
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

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (mode === "member") await onConfirm({ kind: "member", userId: memberId });
      else if (mode === "block") await onConfirm({ kind: "block", label: blockLabel.trim() || "Blocked" });
      else await onConfirm({ kind: "self" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Confirm booking" onClose={onCancel}>
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

      {isAdmin && (
        <AdminOptions
          mode={mode} setMode={setMode}
          memberId={memberId} setMemberId={setMemberId}
          blockLabel={blockLabel} setBlockLabel={setBlockLabel}
          members={members}
        />
      )}

      {!canAfford && (
        <p className="text-sm text-danger-strong mb-3">
          That's more than you have. Top up your wallet, then book.
        </p>
      )}

      <div className="flex gap-2 justify-end">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Keep looking</Button>
        <Button
          onClick={submit}
          disabled={busy || !canAfford || (mode === "member" && memberId === "")}
        >
          {busy ? "Booking…" : free ? "Block the court" : `Book for ${formatCredits(cost)}`}
        </Button>
      </div>
    </Modal>
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
