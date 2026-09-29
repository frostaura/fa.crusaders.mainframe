import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Export } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { PICKER, PLAYERS_REFUSAL } from "@/lib/playersCopy";

/**
 * The two picker tabs that are not a list of members: an OPEN SEAT (anyone with the link takes
 * it — the link itself is minted by the server when the seat is added and shown once, on the
 * booking's result or its page) and a GUEST (a name only; guests pay nothing in the app).
 */

export function LinkTab({ onPick }: { onPick: () => void }) {
  return (
    <div className="grid justify-items-start gap-3 rounded-xl border border-border bg-bg-surface p-4">
      <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent-strong">
        <Export size={20} />
      </span>
      <p className="grid gap-1">
        <span className="text-sm font-semibold text-text-primary">{PICKER.linkBody}</span>
        <span className="text-sm text-text-secondary">{PICKER.linkAfter}</span>
      </p>
      <Button variant="secondary" onClick={onPick}>{PICKER.linkAdd}</Button>
    </div>
  );
}

/** A guest's name as the server takes it: trimmed, 1–64 characters, no control characters. */
function guestNameOk(raw: string): boolean {
  const name = raw.trim();
  // eslint-disable-next-line no-control-regex
  return name.length >= 1 && name.length <= PICKER.guestMax && !/[\u0000-\u001f\u007f]/.test(name);
}

export function GuestTab({ onPick }: { onPick: (name: string) => void }) {
  const [name, setName] = useState("");
  const [problem, setProblem] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!guestNameOk(name)) {
      setProblem(true);
      return;
    }
    onPick(name.trim());
  };
  return (
    <form className="grid justify-items-start gap-3" onSubmit={submit} noValidate>
      <Field invalid={problem} className="w-full">
        <FieldLabel>{PICKER.guestLabel}</FieldLabel>
        <Input
          value={name}
          maxLength={PICKER.guestMax}
          autoComplete="off"
          onChange={(e) => { setName(e.target.value); setProblem(false); }}
        />
        <FieldDescription>{PICKER.guestHint}</FieldDescription>
        {problem ? <FieldError>{PLAYERS_REFUSAL.guest_name_invalid}</FieldError> : null}
      </Field>
      <Button type="submit" variant="secondary">{PICKER.guestAdd}</Button>
    </form>
  );
}
