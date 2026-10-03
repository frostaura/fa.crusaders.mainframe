import { useState } from "react";
import type { PickedPlayer } from "@/components/players/PlayerPicker";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { BookingDetail, PlayerSpec } from "@/lib/playersApi";
import { DETAIL_ACTIONS, SHARE_ASK, firstName } from "@/lib/playersCopy";
import { minutesSpoken } from "@/lib/minutes";
import { askedFigure, defaultAsk, organiserShare } from "./splitEditor";

/**
 * R1 F2.1 — a player added to an amount or ratio split is asked for a share the organiser names.
 * Without it the server seats them at amount 0 (or weight 1): "Asked for 0 min", and the
 * organiser covering a seat they meant to split.
 */
type Props = {
  detail: BookingDetail;
  pick: PickedPlayer;
  onCancel: () => void;
  onAsk: (pick: PickedPlayer, figure: Pick<PlayerSpec, "weight" | "amount">) => void;
};

function whoOf(pick: PickedPlayer): string {
  return pick.kind === "member" ? firstName(pick.name) : DETAIL_ACTIONS.openSeatName;
}

export function ShareAskDialog({ detail, pick, onCancel, onAsk }: Props) {
  const [text, setText] = useState(() => defaultAsk(detail));
  const [tried, setTried] = useState(false);
  const ratio = detail.split_mode === "ratio";
  const who = whoOf(pick);
  const figure = askedFigure(detail, text);
  const error = tried && !figure.ok ? figure.error : null;
  const submit = () => {
    setTried(true);
    if (figure.ok) onAsk(pick, figure.spec);
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent data-dialog="share-ask">
        <DialogHeader>
          <DialogTitle>{SHARE_ASK.title(who)}</DialogTitle>
          <DialogDescription>{ratio ? SHARE_ASK.ratioBody : SHARE_ASK.amountBody(minutesSpoken(organiserShare(detail)))}</DialogDescription>
        </DialogHeader>
        <DialogBody className="pb-4">
          <Field invalid={Boolean(error)}>
            <FieldLabel>{ratio ? SHARE_ASK.weightLabel(who) : SHARE_ASK.amountLabel(who)}</FieldLabel>
            <Input
              value={text}
              inputMode="numeric"
              autoComplete="off"
              maxLength={ratio ? 3 : 9}
              className="w-32 tabular-nums"
              onChange={(e) => setText(e.target.value)}
            />
            <FieldDescription>{ratio ? SHARE_ASK.weightHint : SHARE_ASK.amountHint}</FieldDescription>
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>{SHARE_ASK.cancel}</Button>
          <Button onClick={submit}>{SHARE_ASK.confirm(who)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
