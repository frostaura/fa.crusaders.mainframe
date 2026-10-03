import { useId, useState } from "react";
import { ConfirmDialog } from "../admin/ConfirmDialog";
import { useToast } from "../toastContext";
import { Checkbox } from "../ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { Textarea } from "../ui/textarea";
import { REQUIRED_MARK } from "../../lib/confirmDialogCopy";
import { unsureSentence, writeOrReadBack } from "../../lib/lostReply";
import { LOST_REPLY, unsureWords } from "../../lib/lostReplyCopy";
import { useAuth } from "../../lib/auth";
import { memberDetailEndpoints, type AdminRoleResult } from "../../lib/memberDetailApi";
import { ADMIN_ROLE_CODES, ADMIN_ROLE_COPY as COPY } from "../../lib/memberDetailCopy";

/**
 * Granting or revoking a member's admin rights (R20) — THE act, wherever it is started from: the
 * Access tab's switch, the members list's ⋯ and the record header's ⋯ all open this one dialog
 * (R5 lane G — Dean could not find the switch, so the act came to the list; it was not copied).
 *
 * <ul>
 *   <li><b>A reason both ways</b> (F3.9): it is written to the change record and emailed.</li>
 *   <li><b>Revoking yourself</b> needs a second, explicit yes (`confirm_self`) — the console closes
 *   on you within seconds, and only another admin can undo it.</li>
 *   <li><b>Every refusal</b> — `last_admin`, `not_active_member`, `admin_inherited_from_config`,
 *   `confirm_self_required`, `actor_not_admin` — has its own sentence in the dialog, which stays
 *   open.</li>
 *   <li><b>A lost reply is read back</b> (review round 3): the member read again holds the rights
 *   asked for → it landed; does not → nothing changed; unreadable → not known.</li>
 *   <li><b>Never optimistic.</b> `onChanged` receives what the SERVER answered, and only then does
 *   the caller redraw — a role is not a toggle to be optimistic about.</li>
 * </ul>
 *
 * <p>
 * The reason and the second yes live in this component, so a caller mounts it fresh (a new `key`)
 * for each attempt and nothing typed for one member is carried to the next.
 * </p>
 */
export type AdminRoleDialogProps = {
  userId: string;
  name: string;
  /** What the dialog does: true = make an administrator, false = remove the rights. */
  grant: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes back to — the control that opened it (a switch, a row's ⋯). */
  returnFocus?: () => HTMLElement | null | undefined;
  onChanged: (result: AdminRoleResult) => void | Promise<void>;
};

/** What the dialog says, by what it does and to whom. */
function dialogWords(grant: boolean, self: boolean, name: string) {
  if (grant) {
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

export function AdminRoleDialog(props: AdminRoleDialogProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { userId, name, grant, open, onOpenChange, returnFocus } = props;
  const auth = useAuth();
  const self = auth.status === "authenticated" && auth.userId === userId;
  const act = useAdminRoleChange(props, self);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      {...dialogWords(grant, self, name)}
      codes={ADMIN_ROLE_CODES}
      // R3 A-16: enabled, and a press names what is missing and focuses the reason.
      notReady={!act.ready}
      describe={(error) => unsureSentence(error, unsureWords(
        grant ? COPY.stillNotAdmin(name) : COPY.stillAdmin(name),
        grant ? COPY.whetherGranted(name) : COPY.whetherRevoked(name),
        `${name}'s page`,
      ))}
      notReadyMessage={act.reason.trim() ? COPY.confirmSelfMissing : undefined}
      onConfirm={act.run}
    >
      <ReasonFields grant={grant} self={self} act={act} />
    </ConfirmDialog>
  );
}

type RoleChange = ReturnType<typeof useAdminRoleChange>;

/**
 * The reason, for BOTH directions (review round 1, F3.9 — contract §7), and — for yourself — the
 * second yes. Granting asked for nothing while revoking asked why, so the change record could say
 * why somebody lost the console and never why they were given it.
 */
function ReasonFields({ grant, self, act }: { grant: boolean; self: boolean; act: RoleChange }) {
  const confirmId = useId();
  return (
    <>
      <Field controlId="admin-role-reason">
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          <FieldLabel>{COPY.reason}</FieldLabel>
          <span aria-hidden="true" className="text-sm text-text-secondary">{REQUIRED_MARK}</span>
        </span>
        <Textarea
          required
          aria-required="true"
          value={act.reason}
          onChange={(e) => act.setReason(e.target.value)}
          placeholder={grant ? COPY.grantReasonPlaceholder : COPY.reasonPlaceholder}
        />
        <FieldDescription>{COPY.reasonHint}</FieldDescription>
      </Field>
      {!grant && self ? (
        <div className="flex items-center gap-3">
          <Checkbox id={confirmId} checked={act.confirmSelf} onCheckedChange={(v) => act.setConfirmSelf(v === true)} />
          <label htmlFor={confirmId} className="text-sm font-medium text-text-primary">{COPY.confirmSelf}</label>
        </div>
      ) : null}
    </>
  );
}

/**
 * The request and its aftermath. A rejection is THROWN so the dialog keeps itself open and shows
 * the refusal's own sentence; a success says so, hands the server's answer up, and — when an admin
 * has just removed their own rights — re-asks the server who this session is, so the console
 * closes on them now rather than at their next click.
 */
function useAdminRoleChange(props: AdminRoleDialogProps, self: boolean) {
  const { userId, name, grant, onChanged } = props;
  const toast = useToast();
  const auth = useAuth();
  const [reason, setReason] = useState("");
  const [confirmSelf, setConfirmSelf] = useState(false);

  const run = async () => {
    const { value: result, proven } = await writeOrReadBack(
      () => memberDetailEndpoints.setAdmin(userId, { grant, reason: reason.trim(), ...(!grant && self ? { confirmSelf } : {}) }),
      async () => {
        const now = await memberDetailEndpoints.detail(userId);
        return now.is_admin === grant ? { user_id: userId, is_admin: now.is_admin, admin_source: now.admin_source, changed: true } : null;
      },
    );
    const said = !result.changed ? COPY.unchanged(name, result.is_admin) : grant ? COPY.granted(name) : COPY.revoked(name);
    toast.push({ tone: "success", text: proven ? LOST_REPLY.proven(said) : said });
    await onChanged(result);
    if (!grant && self) void auth.retryConnection();
  };

  return {
    reason, setReason, confirmSelf, setConfirmSelf, run,
    ready: reason.trim().length > 0 && (grant || !self || confirmSelf),
  };
}
