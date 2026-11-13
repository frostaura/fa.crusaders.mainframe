import { useState } from "react";
import { Alert } from "@/components/Alert";
import { SendingNote } from "@/components/bookings/SheetParts";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Coins, Lock } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { keepFiguresWhole } from "@/components/ui/figure-text";
import { UnsureOutcome } from "@/lib/lostReply";
import { minutesSpoken } from "@/lib/minutes";
import { playersEndpoints, type BookingDetail, type DetailPlayer } from "@/lib/playersApi";
import { LEFT_TO_COVER, PLAYERS_LOST, PLAYERS_UNSURE, playersRefusal } from "@/lib/playersCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { useBalance } from "@/lib/useBalance";
import { isCancelled, seatName } from "./detailModel";
import { splitOrProve } from "./detailReadBack";
import {
  assigned, coverers, equalPortions, leftoverChange, leftoverExpected, leftToCover, portionKey, shortPartners,
} from "./leftoverSplit";
import type { Notice, OrganiserHands } from "./useOrganiserHands";

const COINS_ICON = <Coins aria-hidden="true" />;

/**
 * Pay what you can — the organiser's notice on their booking: a partner paid only part of their
 * share, the organiser is covering the rest for now, and "Split what's left" shares it with the
 * other players. Calm, never a debt: it names who could pay less, and what is left.
 */
export function LeftToCoverNotice({ hands }: { hands: OrganiserHands }) {
  const { detail } = hands;
  const left = leftToCover(detail);
  if (detail.viewer.role !== "organiser" || left <= 0 || isCancelled(detail) || !detail.permissions.can_change_split) return null;
  const who = shortPartners(detail).map((p) => seatName(p, detail.players));
  const spoken = minutesSpoken(left);
  return (
    <section
      aria-label={LEFT_TO_COVER.title(spoken)} data-left-to-cover=""
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-3 rounded-xl border border-info-strong/30 bg-info-soft p-4 text-info-strong"
    >
      <Coins size={20} weight="bold" aria-hidden="true" className="shrink-0" />
      <div className="grid min-w-0 flex-1 basis-48 gap-0.5 text-sm">
        <h3 className="font-semibold">{keepFiguresWhole(LEFT_TO_COVER.title(spoken))}</h3>
        <p>{keepFiguresWhole(LEFT_TO_COVER.body(who, spoken))}</p>
      </div>
      <Button size="sm" icon={COINS_ICON} className="ml-auto shrink-0" onClick={hands.openLeftover} data-split-left="">
        {LEFT_TO_COVER.open}
      </Button>
    </section>
  );
}

type DialogProps = {
  detail: BookingDetail;
  onClose: () => void;
  onDone: (notice: Notice) => void;
  /** Read the booking again — a lost reply that did not land, or could not be checked. */
  onStale?: () => void;
  /** Told while the save is in flight, so the page's own ways out (system Back) wait too. */
  onBusyChange?: (busy: boolean) => void;
  /** Ways out refused by the page — the waiting line is said again on each. */
  refused?: number;
};

/**
 * "Split what's left": the short partner's figure locked at what they paid; one whole-minute portion
 * for every other paying player — the organiser first — opening on an equal split (the organiser
 * keeps the remainder); a bar that must reach exactly what is left before Save. Saving is the
 * organiser's re-split (`PUT /bookings/{id}/split`, amount mode), so anyone asked for more is asked
 * to agree first, and the shortfall clears.
 */
export function SplitLeftoverDialog(props: DialogProps) {
  const { detail, onClose, onDone, onStale, onBusyChange, refused = 0 } = props;
  const left = leftToCover(detail);
  const people = coverers(detail);
  const [portions, setPortions] = useState<Record<string, string>>(() => equalPortions(left, people));
  const { refresh } = useBalance();
  const change = leftoverChange(detail, portions);
  const save = useAsyncAction(
    () => {
      const sent = change ?? { mode: "amount" as const, seats: [] };
      return splitOrProve(detail.booking_id, sent, leftoverExpected(sent, detail), () => playersEndpoints.changeSplit(detail.booking_id, sent));
    },
    {
      success: ({ value, proven, answered }) => {
        onBusyChange?.(false);
        const text = value.shares.some((s) => s.needs_consent) ? LEFT_TO_COVER.doneAsked : LEFT_TO_COVER.done;
        onDone({ tone: "success", text: proven ? PLAYERS_LOST(text, answered) : text });
        void refresh({ expectSelf: true });
      },
      failure: (error) => { if (error instanceof UnsureOutcome) { onStale?.(); void refresh({ expectSelf: true }); } },
    },
  );
  const run = () => {
    onBusyChange?.(true);
    void save.run().finally(() => onBusyChange?.(false));
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-dialog="split-leftover">
        <DialogHeader>
          <DialogTitle>{LEFT_TO_COVER.dialogTitle}</DialogTitle>
          <DialogDescription>{keepFiguresWhole(LEFT_TO_COVER.dialogDescription(minutesSpoken(left)))}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 pb-4">
          <ShortSeats detail={detail} />
          <div className="grid gap-3" data-portions="">
            {people.map((p) => (
              <Portion
                key={portionKey(p)} player={p} detail={detail} value={portions[portionKey(p)] ?? ""}
                onChange={(text) => setPortions({ ...portions, [portionKey(p)]: text })}
              />
            ))}
          </div>
          <AssignedBar left={left} portions={portions} people={people} />
          <p className="text-sm text-text-secondary" data-consent-note="">{LEFT_TO_COVER.consent}</p>
          {save.error ? <Alert tone="danger">{playersRefusal(save.error, { action: LEFT_TO_COVER.action, unsure: PLAYERS_UNSURE.split })}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          <SendingNote text={save.pending ? LEFT_TO_COVER.sending : null} refused={refused} />
          {save.pending ? null : <Button variant="outline" onClick={onClose}>{LEFT_TO_COVER.cancel}</Button>}
          <Button pending={save.pending} disabled={change === null} onClick={run} data-save-leftover="">
            {LEFT_TO_COVER.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The partners who paid part: each figure locked at what they paid, with what their share was. */
function ShortSeats({ detail }: { detail: BookingDetail }) {
  const short = shortPartners(detail);
  if (short.length === 0) return null;
  return (
    <ul className="grid gap-2" data-short-seats="">
      {short.map((p) => (
        <li key={p.participant_id ?? p.seat} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-bg-muted p-3 text-sm text-text-secondary">
          <Lock size={16} weight="bold" aria-hidden="true" className="shrink-0 text-text-muted" />
          <span className="min-w-0 flex-1 basis-40 text-text-primary">
            {keepFiguresWhole(LEFT_TO_COVER.paidPart(
              seatName(p, detail.players), minutesSpoken(p.share_minutes), minutesSpoken(p.share_minutes + (p.shortfall_minutes ?? 0)),
            ))}
          </span>
          <span className="text-xs text-text-muted">{LEFT_TO_COVER.locked}</span>
        </li>
      ))}
    </ul>
  );
}

function Portion({ player, detail, value, onChange }: {
  player: DetailPlayer; detail: BookingDetail; value: string; onChange: (text: string) => void;
}) {
  const name = player.kind === "organiser" ? LEFT_TO_COVER.you : seatName(player, detail.players);
  return (
    <Field>
      <FieldLabel>{LEFT_TO_COVER.portionLabel(name)}</FieldLabel>
      <Input
        value={value} inputMode="numeric" autoComplete="off" maxLength={6} className="w-32 tabular-nums"
        data-portion={portionKey(player)} onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

/** "6 of 8 minutes assigned", as a bar and in words, with what is still to assign or one too many. */
function AssignedBar({ left, portions, people }: { left: number; portions: Record<string, string>; people: readonly DetailPlayer[] }) {
  const { total } = assigned(portions, people);
  const gap = left - total;
  const hint = gap > 0 ? LEFT_TO_COVER.under(minutesSpoken(gap)) : gap < 0 ? LEFT_TO_COVER.over(minutesSpoken(-gap)) : null;
  return (
    <div className="grid gap-1.5" data-assigned="">
      <Progress value={Math.min(total, left)} max={left} aria-label={LEFT_TO_COVER.barLabel} />
      <p role="status" className="flex flex-wrap justify-between gap-x-3 text-sm">
        <span className="font-medium tabular-nums text-text-primary" data-assigned-words="">{LEFT_TO_COVER.assigned(total, left)}</span>
        {hint ? <span className="text-text-secondary">{keepFiguresWhole(hint)}</span> : null}
      </p>
    </div>
  );
}
