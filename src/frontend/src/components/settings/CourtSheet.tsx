import { useRef, useState } from "react";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sheet, SheetBody, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useIsSmUp } from "@/components/ui/use-media-query";
import { endpoints, type AdminCourt } from "@/lib/api";
import { COURTS_COPY, COURTS_LOST } from "@/lib/courtsCopy";
import { unsureSentence, writeOrReadBack } from "@/lib/lostReply";
import { LOST_REPLY } from "@/lib/lostReplyCopy";
import { describeFailure } from "@/lib/errors";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { shown, toNumber } from "./draft";

/**
 * Add or edit one court, in a sheet (plan P6: "edit inline via sheet").
 *
 * <p>
 * <b>A sheet, not a row of inputs.</b> The old Courts block was a list of always-live text boxes
 * with a Save and a two-step Deactivate on every row — seven controls a row, each one a way to
 * change a price by accident. Here the list reads, and one press opens the court in a sheet from
 * the right on a desktop and from the bottom on a phone.
 * </p>
 *
 * <p>
 * <b>Taking a court out of use is a switch with its consequence beside it</b>, saved with the rest
 * — the API's own soft deactivation (`isActive: false`), so history stays coherent and the court
 * can be put back in use from the same switch. Nothing already booked is cancelled.
 * </p>
 */
export type CourtSheetProps = {
  /** The court being edited, `"new"` to add one, or null when closed. */
  court: AdminCourt | "new" | null;
  /** A starting price for a new court — the club's usual one. */
  suggestedPrice: number | null;
  onClose: () => void;
  onSaved: () => void;
};

type Draft = { name: string; price: number; active: boolean };

const WHOLE_CENTS = (value: number) => Math.round(value * 100) === value * 100;

function complaints(draft: Draft) {
  // `>= 0`, never `< 0`: lizard's TSX lexer reads a `<` after an identifier as the start of a
  // JSX tag and swallows the rest of the file into this function (`make complexity`).
  const priceOk = Number.isFinite(draft.price) && draft.price >= 0 && WHOLE_CENTS(draft.price);
  return {
    name: draft.name.trim() === "" ? COURTS_COPY.nameRequired : null,
    price: priceOk ? null : COURTS_COPY.priceInvalid,
  };
}

function initialDraft(court: AdminCourt | "new", suggestedPrice: number | null): Draft {
  if (court === "new") return { name: "", price: suggestedPrice ?? Number.NaN, active: true };
  return { name: court.name, price: court.slice_price_credits, active: court.is_active };
}

/** The court on the list now that matches the draft, as the proof a lost write landed. */
async function courtAsDrafted(court: AdminCourt | "new", draft: Draft): Promise<object | null> {
  const name = draft.name.trim();
  const courts = await endpoints.adminCourtsList();
  const found = court === "new" ? courts.find((c) => c.name.trim() === name) : courts.find((c) => c.id === court.id);
  const matches = found && found.name.trim() === name && found.slice_price_credits === draft.price
    && (court === "new" || found.is_active === draft.active);
  return matches ? {} : null;
}

/**
 * The write: a POST for a new court, a PATCH carrying only what changed for an existing one. A
 * lost reply is read back from the courts list (review round 3) — see `COURTS_LOST`.
 */
async function write(court: AdminCourt | "new", draft: Draft) {
  const name = draft.name.trim();
  const send = court === "new"
    ? () => endpoints.adminCourtsCreate({ name, slicePriceCredits: draft.price })
    : () => endpoints.adminCourtsUpdate(court.id, {
      ...(name !== court.name ? { name } : {}),
      ...(draft.price !== court.slice_price_credits ? { slicePriceCredits: draft.price } : {}),
      ...(draft.active !== court.is_active ? { isActive: draft.active } : {}),
    });
  const { proven } = await writeOrReadBack(async () => { await send(); return {}; }, () => courtAsDrafted(court, draft));
  const done = court === "new" ? COURTS_COPY.added(name) : COURTS_COPY.saved(name);
  return proven ? LOST_REPLY.proven(done) : done;
}

function CourtForm({ court, suggestedPrice, onDone }: { court: AdminCourt | "new"; suggestedPrice: number | null; onDone: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(court, suggestedPrice));
  const [tried, setTried] = useState(false);
  const isNew = court === "new";
  const save = useAsyncAction(() => write(court, draft), { success: onDone, toast: { success: (text) => text } });
  const problems = complaints(draft);
  const nameInput = useRef<HTMLInputElement>(null);
  const priceInput = useRef<HTMLInputElement>(null);
  const submit = () => {
    setTried(true);
    // Refused at the sheet, with focus on the field to fix — never a toast that fades.
    if (problems.name) { nameInput.current?.focus(); return; }
    if (problems.price) { priceInput.current?.focus(); return; }
    void save.run();
  };

  return (
    <form
      noValidate
      className="contents"
      onSubmit={(event) => { event.preventDefault(); submit(); }}
    >
      <SheetBody className="flex flex-col gap-5">
        <Field>
          <FieldLabel>{COURTS_COPY.nameLabel}</FieldLabel>
          <Input
            ref={nameInput}
            value={draft.name}
            placeholder="Court 5"
            autoComplete="off"
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
          <FieldError>{tried ? problems.name : null}</FieldError>
          <FieldDescription>{COURTS_COPY.nameDescription}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>{COURTS_COPY.priceLabel}</FieldLabel>
          <div className="relative">
            <Input
              ref={priceInput}
              type="number"
              inputMode="decimal"
              min={0}
              step={0.01}
              value={shown(draft.price)}
              className="pr-14 tabular-nums"
              onChange={(event) => setDraft({ ...draft, price: toNumber(event.target.value) })}
            />
            <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-9 flex items-center text-sm text-text-muted">cr</span>
          </div>
          <FieldError>{tried ? problems.price : null}</FieldError>
          <FieldDescription>{COURTS_COPY.priceDescription}</FieldDescription>
        </Field>
        {isNew ? null : (
          <Field>
            <FieldLabel>{COURTS_COPY.activeLabel}</FieldLabel>
            <div className="flex min-h-touch items-center gap-3">
              <Switch checked={draft.active} onCheckedChange={(active) => setDraft({ ...draft, active })} />
              <span className="text-sm text-text-secondary">{draft.active ? COURTS_COPY.activeOn : COURTS_COPY.activeOff}</span>
            </div>
          </Field>
        )}
        {save.error ? (
          <Alert tone="danger" live="assertive">
            {unsureSentence(save.error, isNew ? COURTS_LOST.add(draft.name.trim()) : COURTS_LOST.save(draft.name.trim()))
              ?? describeFailure(save.error, { action: isNew ? COURTS_COPY.addAction : COURTS_COPY.saveAction, codes: COURTS_COPY.errorCodes })}
          </Alert>
        ) : null}
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button type="button" variant="outline" disabled={save.pending}>{COURTS_COPY.cancel}</Button>
        </SheetClose>
        <Button type="submit" pending={save.pending}>{isNew ? COURTS_COPY.saveNew : COURTS_COPY.saveEdit}</Button>
      </SheetFooter>
    </form>
  );
}

export function CourtSheet({ court, suggestedPrice, onClose, onSaved }: CourtSheetProps) {
  const wide = useIsSmUp();
  const open = court !== null;
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      {court !== null ? (
        <SheetContent side={wide ? "right" : "bottom"}>
          <SheetHeader>
            <SheetTitle>{court === "new" ? COURTS_COPY.addTitle : COURTS_COPY.editTitle(court.name)}</SheetTitle>
            <SheetDescription>{court === "new" ? COURTS_COPY.addDescription : COURTS_COPY.editDescription}</SheetDescription>
          </SheetHeader>
          <CourtForm
            key={court === "new" ? "new" : court.id}
            court={court}
            suggestedPrice={suggestedPrice}
            onDone={() => { onSaved(); onClose(); }}
          />
        </SheetContent>
      ) : null}
    </Sheet>
  );
}
