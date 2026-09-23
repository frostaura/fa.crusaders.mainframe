import { useId, useRef, useState } from "react";
import { ConfirmDialog } from "../admin/ConfirmDialog";
import { useToast } from "../Toast";
import { Checkbox } from "../ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { Lock } from "../ui/icons";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { useAuth } from "../../lib/auth";
import {
  memberDetailEndpoints, type AdminRoleResult, type AdminSource, type MembershipStatus,
} from "../../lib/memberDetailApi";
import { ADMIN_ROLE_CODES, ADMIN_ROLE_COPY as COPY } from "../../lib/memberDetailCopy";

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
 * <ul>
 *   <li><b>Granting</b> asks once.</li>
 *   <li><b>Revoking</b> requires a reason: it is written to the change record and emailed.</li>
 *   <li><b>Revoking yourself</b> requires a second, explicit yes (`confirm_self`) — the page you
 *   are on stops working within seconds, and only another admin can undo it.</li>
 *   <li><b>A config admin</b> (`Admins:Emails`) is shown locked with the reason: the console
 *   cannot remove it, and a switch that looks pressable and is always refused is a lie.</li>
 *   <li><b>A member who is not active</b> cannot be granted; the switch says so before anyone
 *   presses it rather than after a 409.</li>
 * </ul>
 *
 * <p>
 * Every refusal the route can give — `last_admin`, `not_active_member`,
 * `admin_inherited_from_config`, `confirm_self_required`, `actor_not_admin` — has its own
 * sentence, shown inside the dialog, which stays open.
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

type Mode = "grant" | "revoke" | null;

/** What the dialog says, by what it does and to whom. */
function dialogWords(mode: "grant" | "revoke", self: boolean, name: string) {
  if (mode === "grant") {
    return { tone: "primary" as const, title: COPY.grantTitle(name), description: COPY.grantBody(name), confirmLabel: COPY.grantConfirm, action: COPY.grantAction };
  }
  return {
    tone: "danger" as const,
    title: self ? COPY.revokeSelfTitle : COPY.revokeTitle(name),
    description: self ? COPY.revokeSelfBody : COPY.revokeBody(name),
    confirmLabel: COPY.revokeConfirm,
    action: COPY.revokeAction,
  };
}

/** Why the switch cannot be pressed, or null when it can. */
function lockReason(isAdmin: boolean, adminSource: AdminSource | null, status: MembershipStatus | null): string | null {
  if (isAdmin && adminSource === "config") return COPY.configLocked;
  if (!isAdmin && status !== "Active") return COPY.notActive;
  return null;
}

export function AdminRoleSwitch(props: AdminRoleSwitchProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { userId, name, isAdmin, adminSource, status } = props;
  const auth = useAuth();
  const self = auth.status === "authenticated" && auth.userId === userId;
  const control = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [open, setOpen] = useState(false);
  const locked = lockReason(isAdmin, adminSource, status);
  const act = useRoleChange(props, self);

  const begin = (next: boolean) => {
    act.reset();
    setMode(next ? "grant" : "revoke");
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
      {mode ? (
        <ConfirmDialog
          key={mode}
          open={open}
          onOpenChange={setOpen}
          returnFocus={() => control.current}
          {...dialogWords(mode, self, name)}
          codes={ADMIN_ROLE_CODES}
          confirmDisabled={mode === "revoke" && !act.ready}
          onConfirm={() => act.run(mode === "grant")}
        >
          {mode === "revoke" ? <RevokeFields self={self} act={act} /> : null}
        </ConfirmDialog>
      ) : null}
    </>
  );
}

type RoleChange = ReturnType<typeof useRoleChange>;

/** The reason, and — for yourself — the second yes. */
function RevokeFields({ self, act }: { self: boolean; act: RoleChange }) {
  const confirmId = useId();
  return (
    <>
      <Field controlId="admin-role-reason">
        <FieldLabel>{COPY.reason}</FieldLabel>
        <Textarea value={act.reason} onChange={(e) => act.setReason(e.target.value)} placeholder={COPY.reasonPlaceholder} />
        <FieldDescription>{COPY.reasonHint}</FieldDescription>
      </Field>
      {self ? (
        <div className="flex items-center gap-3">
          <Checkbox id={confirmId} checked={act.confirmSelf} onCheckedChange={(v) => act.setConfirmSelf(v === true)} />
          <label htmlFor={confirmId} className="text-sm font-medium text-text-primary">{COPY.confirmSelf}</label>
        </div>
      ) : null}
    </>
  );
}

/**
 * The request and its aftermath. A rejection is THROWN so the dialog keeps itself open and
 * shows the refusal's own sentence; a success says so, hands the server's answer up, and — when
 * an admin has just removed their own rights — re-asks the server who this session is, so the
 * console closes on them now rather than at their next click.
 */
function useRoleChange(props: AdminRoleSwitchProps, self: boolean) {
  const { userId, name, onChanged } = props;
  const toast = useToast();
  const auth = useAuth();
  const [reason, setReason] = useState("");
  const [confirmSelf, setConfirmSelf] = useState(false);

  const run = async (grant: boolean) => {
    const result = await memberDetailEndpoints.setAdmin(userId, {
      grant,
      ...(grant ? {} : { reason: reason.trim() }),
      ...(!grant && self ? { confirmSelf } : {}),
    });
    toast.push({
      tone: "success",
      text: !result.changed ? COPY.unchanged(name, result.is_admin) : grant ? COPY.granted(name) : COPY.revoked(name),
    });
    await onChanged(result);
    if (!grant && self) void auth.retryConnection();
  };

  return {
    reason, setReason, confirmSelf, setConfirmSelf, run,
    ready: reason.trim().length > 0 && (!self || confirmSelf),
    reset: () => { setReason(""); setConfirmSelf(false); },
  };
}
