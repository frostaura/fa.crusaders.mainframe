import { useState } from "react";
import { Modal } from "./Modal";
import { Button, Label, fieldClassName } from "./Button";
import { CostSummary, OverdraftNotice, Refusal, ShortfallPrompt } from "./BookingConfirmParts";
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
 * Only a SUCCESS is `done`, because only a success unmounts this dialog. Every refusal
 * comes back into the modal, because the modal is where the person who pressed the button
 * is looking.
 * </p>
 *
 * <p>
 * `short` is §8's case: the member being booked for cannot cover the court, and the
 * decision about whether to overdraw them belongs to the admin looking at the figures, so
 * it turns into an override offer rather than a sentence. `refused` is every other
 * refusal — the per-day cap, peak hours, a slot someone else just took, a 502 from a
 * wedged gateway. Those used to leave as a page-level toast: the dialog stayed open with
 * its button back at rest and NOTHING in it, the toast painted under the modal's own
 * scrim, and it cleared itself after four seconds while the dialog stayed armed. A member
 * watching the dialog saw a button that did nothing and was never told why.
 * </p>
 */
export type BookingOutcome =
  | { kind: "done" }
  | { kind: "refused"; message: string }
  | { kind: "short"; currentCredits: number; requiredCredits: number };

type Props = {
  intent: BookingIntent;
  balanceCredits: number | null;
  /**
   * Members to offer when an admin books on behalf, each with the credit the club last
   * read for them. Empty for a member.
   */
  members: { userId: string; name: string; balanceCredits: number | null }[];
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
  const [mode, setMode] = useState<Mode>(openingMode(isAdmin));
  const [memberId, setMemberId] = useState("");
  const [blockLabel, setBlockLabel] = useState("Tournament");
  const [busy, setBusy] = useState(false);
  // The server's answer to the first attempt, when the member turned out to be short.
  // Held here rather than on the page because it is the reason the modal is still open.
  const [shortfall, setShortfall] = useState<{ current: number; required: number } | null>(null);
  // The last refusal, in the dialog that caused it. Same reasoning as the shortfall above:
  // it is the reason this dialog is still on screen, so it belongs to this dialog.
  const [refusal, setRefusal] = useState<string | null>(null);

  // Any change of who or what is being booked invalidates the figures above — they belong
  // to one member and one attempt. Cleared in the setters rather than in an effect so
  // there is no frame in which last member's shortfall is displayed against this one.
  const clearAnswer = () => { setShortfall(null); setRefusal(null); };
  const changeMode = (next: Mode) => { clearAnswer(); setMode(next); };
  const changeMember = (next: string) => { clearAnswer(); setMemberId(next); };

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
    clearAnswer();
    try {
      const outcome = await onConfirm(optionFor(overrideBalance));
      // A success unmounts this dialog. Everything else stays here and says why: a short
      // member as §8's override offer with the figures on it, every other refusal as a
      // sentence inside the dialog the member is looking at.
      setShortfall(outcome.kind === "short" ? { current: outcome.currentCredits, required: outcome.requiredCredits } : null);
      setRefusal(outcome.kind === "refused" ? outcome.message : null);
    } finally {
      setBusy(false);
    }
  };

  const picked = pickedMember(members, memberId, chargedToSomeoneElse);

  return (
    <Modal title="Confirm booking" onClose={onCancel}>
      <CostSummary
        intent={intent} balanceCredits={balanceCredits} memberBalance={picked.balance}
        free={free} cost={cost} chargedToSomeoneElse={chargedToSomeoneElse} canAfford={canAfford}
      />

      {isAdmin && (
        <AdminOptions
          mode={mode} setMode={changeMode}
          memberId={memberId} setMemberId={changeMember}
          blockLabel={blockLabel} setBlockLabel={setBlockLabel}
          members={members}
        />
      )}

      {!canAfford && <ShortfallPrompt />}

      {refusal && <Refusal message={refusal} />}

      {shortfall && <OverdraftNotice name={picked.name} current={shortfall.current} required={shortfall.required} />}

      <ConfirmActions
        busy={busy} free={free} cost={cost} shortfall={shortfall}
        blocked={!canAfford || (mode === "member" && memberId === "")}
        onCancel={onCancel} onSubmit={submit}
      />
    </Modal>
  );
}

/**
 * The member the desk has picked, as the dialog needs to talk about them.
 *
 * <p>
 * §8: "The confirmation modal shows the member's name, their balance, the price and the
 * balance it will leave." Only the refusal panel used to carry the two figures, so a desk
 * spending the credit of a member who COULD afford it never saw whose money it was
 * spending, how much they had, or what it left them. The balance is null unless the member
 * is the one being charged, so no other mode can render somebody else's wallet.
 * </p>
 */
function pickedMember(members: Props["members"], memberId: string, charged: boolean) {
  const found = members.find((m) => m.userId === memberId);
  return {
    name: found?.name ?? "That member",
    balance: charged ? found?.balanceCredits ?? null : null,
  };
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
 *
 * <p>
 * <b>Item 12 reaches the glyph and the press, and deliberately not an outcome phase.</b> The
 * outcome phase needs `onAction`, which reads a resolve as success — and this dialog's
 * `submit` resolves for a REFUSAL too, because a refusal is a value here rather than a thrown
 * thing and belongs in the panel above rather than on the button. Wiring `onAction` would
 * flash a green tick over "that slot has just gone". A success unmounts the dialog; a refusal
 * is announced by `Refusal`'s `role="alert"`. Nothing here needs a second voice, so no call
 * site sets `announcedElsewhere` — it only means anything alongside `onAction`.
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
      <Button intent="decline" variant="ghost" onClick={onCancel} disabled={busy}>Keep looking</Button>
      {shortfall ? (
        /*
          `destructive`, not `affirm` — and the distinction is ruling 4's, not a shade of it.

          The action is affirmative (it books a court) and its CONSEQUENCE is not: it pushes a
          member into a negative balance on a desk clerk's judgement, and the label says so in
          figures. A thumbs-up beside "leaves -12.00 cr" is the software approving of that.
          `destructive` draws no thumb at all, settles instead of snapping, and keeps the
          danger variant the button already wore.
        */
        <Button intent="destructive" variant="danger" onClick={() => onSubmit(true)} disabled={busy}>
          {busy ? "Booking…" : `Book anyway — leaves ${formatCredits(shortfall.current - shortfall.required)}`}
        </Button>
      ) : (
        <Button intent="affirm" onClick={() => onSubmit(false)} disabled={busy || blocked}>
          {busy ? "Booking…" : free ? "Block the court" : `Book for ${formatCredits(cost)}`}
        </Button>
      )}
    </div>
  );
}

type Mode = "self" | "member" | "block";

/**
 * Which of §8's three admin actions the dialog opens on.
 *
 * <p>
 * N-F11: an admin opens on "on behalf of a member", not on their own wallet. §8 is explicit
 * that "a desk account's balance is zero permanently, because it never plays", so defaulting
 * to "My own booking" made the FIRST state of this dialog, on every slot, every time, a
 * refusal of the person who had just opened it — `Balance now 0.00 cr · Balance after
 * -50.00 cr`, "That's more than you have", and a disabled Book button — and the admin had to
 * notice the select and change it before the dialog did anything useful. "My own booking" is
 * still there for an admin who does play: it is the default that was wrong, not the option.
 * </p>
 */
function openingMode(isAdmin: boolean): Mode {
  return isAdmin ? "member" : "self";
}

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
  const field = fieldClassName;
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
