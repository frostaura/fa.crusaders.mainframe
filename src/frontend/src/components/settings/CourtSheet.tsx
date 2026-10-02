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

/**
 * Add or edit one court, in a sheet (plan P6: "edit inline via sheet").
 *
 * <p>
 * <b>A sheet, not a row of inputs.</b> The old Courts block was a list of always-live text boxes
 * with a Save and a two-step Deactivate on every row — seven controls a row, each one a way to
 * change a court by accident. Here the list reads, and one press opens the court in a sheet from
 * the right on a desktop and from the bottom on a phone.
 * </p>
 *
 * <p>
 * <b>Taking a court out of use is a switch with its consequence beside it</b>, saved with the rest
 * — the API's own soft deactivation (`isActive: false`), so history stays coherent and the court
 * can be put back in use from the same switch. Nothing already booked is cancelled.
 * </p>
 *
 * <p>
 * <b>No price</b> (P13, contract §3.9): a booking costs its playing minutes, whatever the court, so
 * the sheet is the name and the in-use switch, and a new court is posted as `{ name, courtType }`.
 * </p>
 */
export type CourtSheetProps = {
  /** The court being edited, `"new"` to add one, or null when closed. */
  court: AdminCourt | "new" | null;
  /** @deprecated ignored — remove with dialog-focus-return's prop (P13 ask F3→integrator) */
  suggestedPrice?: number | null;
  onClose: () => void;
  onSaved: () => void;
};

type Draft = { name: string; active: boolean };

function nameProblem(draft: Draft) {
  return draft.name.trim() === "" ? COURTS_COPY.nameRequired : null;
}

function initialDraft(court: AdminCourt | "new"): Draft {
  if (court === "new") return { name: "", active: true };
  return { name: court.name, active: court.is_active };
}

/** The court on the list now that matches the draft, as the proof a lost write landed. */
async function courtAsDrafted(court: AdminCourt | "new", draft: Draft): Promise<object | null> {
  const name = draft.name.trim();
  const courts = await endpoints.adminCourtsList();
  const found = court === "new" ? courts.find((c) => c.name.trim() === name) : courts.find((c) => c.id === court.id);
  const matches = found && found.name.trim() === name && (court === "new" || found.is_active === draft.active);
  return matches ? {} : null;
}

/**
 * The write: a POST for a new court, a PATCH carrying only what changed for an existing one. A
 * lost reply is read back from the courts list (review round 3) — see `COURTS_LOST`.
 */
async function write(court: AdminCourt | "new", draft: Draft) {
  const name = draft.name.trim();
  const send = court === "new"
    ? () => endpoints.adminCourtsCreate({ name })
    : () => endpoints.adminCourtsUpdate(court.id, {
      ...(name !== court.name ? { name } : {}),
      ...(draft.active !== court.is_active ? { isActive: draft.active } : {}),
    });
  const { proven } = await writeOrReadBack(async () => { await send(); return {}; }, () => courtAsDrafted(court, draft));
  const done = court === "new" ? COURTS_COPY.added(name) : COURTS_COPY.saved(name);
  return proven ? LOST_REPLY.proven(done) : done;
}

function CourtForm({ court, onDone }: { court: AdminCourt | "new"; onDone: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(court));
  const [tried, setTried] = useState(false);
  const isNew = court === "new";
  const save = useAsyncAction(() => write(court, draft), { success: onDone, toast: { success: (text) => text } });
  const problem = nameProblem(draft);
  const nameInput = useRef<HTMLInputElement>(null);
  const submit = () => {
    setTried(true);
    // Refused at the sheet, with focus on the field to fix — never a toast that fades.
    if (problem) { nameInput.current?.focus(); return; }
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
          <FieldError>{tried ? problem : null}</FieldError>
          <FieldDescription>{COURTS_COPY.nameDescription}</FieldDescription>
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

export function CourtSheet({ court, onClose, onSaved }: CourtSheetProps) {
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
            onDone={() => { onSaved(); onClose(); }}
          />
        </SheetContent>
      ) : null}
    </Sheet>
  );
}
