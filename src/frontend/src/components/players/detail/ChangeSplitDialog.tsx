import { useMemo, useState } from "react";
import { Alert } from "@/components/Alert";
import { SendingNote } from "@/components/bookings/SheetParts";
import { SplitStep } from "@/components/bookings/SplitStep";
import { hasPaying, updateSeat, withMode, type PlayersDraft } from "@/components/bookings/playersDraft";
import { useSplitPreview } from "@/components/bookings/useSplitPreview";
import type { SplitEditor as StepEditor } from "@/components/bookings/usePlayersStep";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useBalance } from "@/lib/balance";
import { playersEndpoints, type BookingDetail, type SplitMode } from "@/lib/playersApi";
import { UnsureOutcome } from "@/lib/lostReply";
import { CHANGE_SPLIT, PLAYERS_LOST, PLAYERS_UNSURE, playersRefusal } from "@/lib/playersCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { splitOrProve } from "./detailReadBack";
import { draftOf, splitChangeOf, splitEffects } from "./splitEditor";
import type { Notice } from "./useOrganiserHands";

/**
 * R1 F2.1 — the organiser changes the split of a booking that already stands: Equal · Ratio ·
 * Amount, each seat's figure, and the live totals — the BookSheet's own Split step, on a draft
 * built from the live seats. Saving is `PUT /bookings/{id}/split`; the server asks again anyone
 * whose share went up, and a share that went down comes back at its reconcile.
 */
type Props = {
  detail: BookingDetail;
  onClose: () => void;
  onDone: (notice: Notice) => void;
  /** Read the booking again — a lost reply that did not land, or could not be checked (R3). */
  onStale?: () => void;
  /** R5 I5-2 — told while the save is in flight, so the page's own ways out (system Back) wait too. */
  onBusyChange?: (busy: boolean) => void;
  /** Ways out refused by the page (the system Back) — the waiting line is said again on each. */
  refused?: number;
};

/**
 * What the BookSheet's Split step reads of its players state — and all an existing booking can
 * give it: the draft, the mode and figure setters, the live preview. There is nothing to pick
 * (the seats are the booking's own), so the rest of the BookSheet's state is not faked here.
 */
type SplitEditor = StepEditor & { problem: string | null };

function useSplitEditor(detail: BookingDetail): SplitEditor {
  const [draft, setDraft] = useState<PlayersDraft>(() => draftOf(detail));
  const prices = useMemo(() => [detail.money.price_minutes], [detail.money.price_minutes]);
  const preview = useSplitPreview(prices, draft, hasPaying(draft));
  return {
    draft, bulk: false, preview,
    problem: preview.state.status === "invalid" ? preview.state.error : null,
    setMode: (mode: SplitMode) => setDraft(withMode(draft, mode, detail.money.price_minutes)),
    setWeight: (seat: number, weight: string) => setDraft(updateSeat(draft, seat, { weight })),
    setAmount: (seat: number, amount: string) => setDraft(updateSeat(draft, seat, { amount })),
    setOrganiserWeight: (organiserWeight: string) => setDraft({ ...draft, organiserWeight }),
  };
}

export function ChangeSplitDialog(props: Props) {
  const { detail, onClose, onDone, onStale, onBusyChange, refused = 0 } = props;
  const editor = useSplitEditor(detail);
  const { refresh } = useBalance();
  const body = splitChangeOf(detail, editor.draft);
  // R3 lost-reply audit — a lost reply is read back: the booking's mode and every seat's share
  // as the preview said they would be.
  const save = useAsyncAction(
    () => {
      const sent = body ?? { mode: editor.draft.mode, seats: [] };
      const state = editor.preview.state;
      const expected = state.status === "ready" && state.previews.length > 0 ? state.previews[0].shares : [];
      return splitOrProve(detail.booking_id, sent, expected, () => playersEndpoints.changeSplit(detail.booking_id, sent));
    },
    {
      success: ({ value, proven }) => {
        onBusyChange?.(false); // answered: the close that follows is not a way out mid-flight
        const askedAgain = value.shares.some((s) => s.needs_consent);
        const text = askedAgain ? CHANGE_SPLIT.doneAskedAgain : CHANGE_SPLIT.done;
        onDone({ tone: "success", text: proven ? PLAYERS_LOST(text) : text });
        void refresh({ expectSelf: true });
      },
      failure: (error) => { if (error instanceof UnsureOutcome) { onStale?.(); void refresh({ expectSelf: true }); } },
    },
  );
  const blocked = body === null || editor.problem !== null || editor.preview.state.status !== "ready";
  // Told at once, not in an effect: a Back a frame after the press is refused too.
  const run = () => {
    onBusyChange?.(true);
    void save.run().finally(() => onBusyChange?.(false));
  };
  return (
    // R5 I5-2 — the page decides every close (Cancel, ×, Escape, scrim, system Back): refused while
    // the save is on its way, with the waiting line said again.
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-dialog="change-split">
        <DialogHeader>
          <DialogTitle>{CHANGE_SPLIT.title}</DialogTitle>
          <DialogDescription>{CHANGE_SPLIT.description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 pb-4">
          {/* The booking is paid for: "What saving does" below says what moves (R2 F2-3). */}
          <SplitStep players={editor} hidePayNow />
          <SplitEffects detail={detail} editor={editor} />
          {save.error ? <Alert tone="danger">{playersRefusal(save.error, { action: CHANGE_SPLIT.action, unsure: PLAYERS_UNSURE.split })}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <SendingNote text={save.pending ? CHANGE_SPLIT.sending : null} refused={refused} />
          {save.pending ? null : <Button variant="outline" onClick={onClose}>{CHANGE_SPLIT.cancel}</Button>}
          <Button pending={save.pending} disabled={blocked} onClick={run} data-save-split="">
            {CHANGE_SPLIT.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** R2 F2-3 — the money saving moves on a booking that stands, once the server has split it. */
function SplitEffects({ detail, editor }: { detail: BookingDetail; editor: SplitEditor }) {
  const state = editor.preview.state;
  if (state.status !== "ready" || state.previews.length === 0) return null;
  const lines = splitEffects(detail, state.previews[0].shares);
  return (
    <section aria-label={CHANGE_SPLIT.effectsTitle} data-split-effects="" className="grid gap-2 rounded-xl border border-border bg-bg-surface p-4 text-sm">
      <h3 className="font-semibold text-text-primary">{CHANGE_SPLIT.effectsTitle}</h3>
      <ul className="grid gap-1 text-text-secondary">
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </section>
  );
}
