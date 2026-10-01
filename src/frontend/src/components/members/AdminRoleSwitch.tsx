import { useRef, useState } from "react";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { Lock } from "../ui/icons";
import { Switch } from "../ui/switch";
import type { AdminRoleResult, AdminSource, MembershipStatus } from "../../lib/memberDetailApi";
import { ADMIN_ROLE_COPY as COPY } from "../../lib/memberDetailCopy";
import { AdminRoleDialog } from "./AdminRoleDialog";
import { adminRoleOffer } from "./adminRoleOffer";

/**
 * Grant or revoke a member's admin rights (R20) — a Switch that never flips on its own.
 *
 * <p>
 * <b>The switch is the state; the dialog is the act.</b> Pressing it does not change anything:
 * it opens a confirm dialog that says what the change MEANS, and only the dialog's
 * outcome-named primary ("Make administrator", "Remove admin rights") sends the request. The
 * switch then shows what the server answered, never what was hoped for — a role is not a toggle
 * to be optimistic about.
 * </p>
 *
 * <p>
 * The act itself — the reason both ways, the self-revoke second yes, a sentence for every refusal,
 * the lost-reply read-back — is {@link AdminRoleDialog}, the same one the members list's ⋯ and the
 * record header's ⋯ open (R5 lane G). This file is the switch: a config admin (`Admins:Emails`) is
 * shown locked with the reason, because a switch that looks pressable and is always refused is a
 * lie; a member who is not active cannot be granted, and the switch says so before anyone presses
 * it rather than after a 409. Both rules are {@link adminRoleOffer}, shared with the menus.
 * </p>
 */
export type AdminRoleSwitchProps = {
  userId: string;
  name: string;
  isAdmin: boolean;
  adminSource: AdminSource | null;
  status: MembershipStatus | null;
  onChanged: (result: AdminRoleResult) => void | Promise<void>;
};

export function AdminRoleSwitch(props: AdminRoleSwitchProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { userId, name, isAdmin, adminSource, status, onChanged } = props;
  const control = useRef<HTMLButtonElement>(null);
  // Which attempt, and whether its dialog is open, are separate: the dialog stays mounted after
  // it closes so its exit animation and its focus return both run; a new attempt is a new key,
  // so nothing typed last time is carried over.
  const [attempt, setAttempt] = useState<{ n: number; grant: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const { locked } = adminRoleOffer(isAdmin, adminSource, status);

  const begin = (next: boolean) => {
    setAttempt((a) => ({ n: (a?.n ?? 0) + 1, grant: next }));
    setOpen(true);
  };

  return (
    <>
      <Field className="grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4" data-admin-role="">
        <FieldLabel className="col-start-1 row-start-1 text-base font-semibold">{COPY.label}</FieldLabel>
        <Switch
          ref={control}
          className="col-start-2 row-span-2 row-start-1"
          checked={isAdmin}
          disabled={locked !== null}
          onCheckedChange={begin}
        />
        <FieldDescription className="col-start-1 row-start-2">
          {isAdmin ? COPY.descriptionOn(name) : COPY.descriptionOff(name)}
        </FieldDescription>
      </Field>
      {locked ? (
        <p className="flex items-start gap-2 rounded-lg bg-bg-muted px-3 py-2.5 text-sm text-text-secondary">
          <Lock size={16} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{locked}</span>
        </p>
      ) : null}
      {attempt ? (
        <AdminRoleDialog
          key={attempt.n}
          userId={userId}
          name={name}
          grant={attempt.grant}
          open={open}
          onOpenChange={setOpen}
          returnFocus={() => control.current}
          onChanged={onChanged}
        />
      ) : null}
    </>
  );
}
