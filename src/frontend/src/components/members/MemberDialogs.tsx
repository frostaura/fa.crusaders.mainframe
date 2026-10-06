import { useState, type Dispatch, type SetStateAction } from "react";
import { REQUIRED_MARK } from "@/lib/confirmDialogCopy";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { useToast } from "@/components/toastContext";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Copy } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import type { BiometricEnrollmentRow } from "@/lib/api";
import {
  OUTCOMES, PASSWORD_DIALOG, REACTIVATE_DIALOG, REJECT_DIALOG, RESET_DIALOG, SUSPEND_DIALOG,
} from "@/lib/membersCopy";
import { ResetMemberCodeDialog } from "@/components/member-code/ResetMemberCodeDialog";
import type { AdminRoleResult } from "@/lib/memberDetailApi";
import { AdminRoleDialog } from "./AdminRoleDialog";
import { DeleteMemberDialog } from "./DeleteMemberDialog";
import { FingerprintsDialog } from "./FingerprintsDialog";
import { rowMenuOf, type MemberRow } from "./membersModel";
import type { MemberLifecycle, ResetResult } from "./useMemberLifecycle";

/**
 * The list's dialogs, one open at a time (P5: "dialogs shared, always ×, outcome-named verbs").
 *
 * <p>
 * Reject, suspend, reactivate and reset are the shared `ConfirmDialog`: the question as the title,
 * the consequence as the description, a primary named for its outcome ("Suspend member", never
 * "OK"), real pending, and a failure that stays in the dialog. Dismissing returns focus to the
 * row's ⋯ button it came from rather than to `<body>`.
 * </p>
 */
export type MemberDialogState =
  | { kind: "reject" | "suspend" | "reactivate" | "reset" | "resetCode" | "fingerprints" | "adminRole" | "delete"; member: MemberRow }
  | { kind: "password"; member: MemberRow; result: ResetResult }
  | null;

type Props = {
  dialog: MemberDialogState;
  setDialog: Dispatch<SetStateAction<MemberDialogState>>;
  lifecycle: MemberLifecycle;
  fingerprints: Record<string, BiometricEnrollmentRow>;
  readFingerprints: () => Promise<void>;
  /** The server's answer to a grant or revoke — the row is redrawn from it, never before (R5 G). */
  onRoleChanged: (result: AdminRoleResult) => void;
  /** After the club has deleted a member — the list reads the club again, and they are no longer on it. */
  onMemberDeleted: () => void | Promise<void>;
};

export function MemberDialogs(props: Props) {
  const { dialog, setDialog } = props;
  if (!dialog) return null;
  /** Close THIS dialog only — a success that opened the next one must not be undone by it. */
  const closeIf = (kind: string) => (open: boolean) => {
    if (!open) setDialog((current) => (current?.kind === kind ? null : current));
  };
  switch (dialog.kind) {
    case "reject": return <ReasonDialog kind="reject" member={dialog.member} onOpenChange={closeIf("reject")} {...props} />;
    case "suspend": return <ReasonDialog kind="suspend" member={dialog.member} onOpenChange={closeIf("suspend")} {...props} />;
    case "reactivate": return <ReactivateDialog member={dialog.member} onOpenChange={closeIf("reactivate")} lifecycle={props.lifecycle} />;
    case "reset": return <ResetDialog member={dialog.member} onOpenChange={closeIf("reset")} {...props} />;
    case "resetCode": return (
      <ResetMemberCodeDialog
        name={dialog.member.full_name} membershipId={dialog.member.membership_id}
        onOpenChange={closeIf("resetCode")} returnFocus={() => rowMenuOf(dialog.member.user_id)}
      />
    );
    case "password": return <PasswordDialog result={dialog.result} onClose={() => closeIf("password")(false)} />;
    case "adminRole": return (
      <AdminRoleDialog
        key={dialog.member.user_id} userId={dialog.member.user_id} name={dialog.member.full_name} grant={dialog.member.is_admin !== true}
        open onOpenChange={closeIf("adminRole")} returnFocus={() => rowMenuOf(dialog.member.user_id)}
        onChanged={props.onRoleChanged}
      />
    );
    case "delete": return (
      <DeleteMemberDialog
        key={dialog.member.user_id} userId={dialog.member.user_id} name={dialog.member.full_name}
        open onOpenChange={closeIf("delete")} returnFocus={() => rowMenuOf(dialog.member.user_id)}
        onDeleted={props.onMemberDeleted}
      />
    );
    case "fingerprints": return (
      <FingerprintsDialog
        member={dialog.member}
        templates={props.fingerprints[dialog.member.user_id]?.templates ?? []}
        onChange={props.readFingerprints}
        onClose={() => closeIf("fingerprints")(false)}
      />
    );
  }
}

/** Reject and suspend: both need a reason, because the member is emailed it verbatim. */
function ReasonDialog({ kind, member, onOpenChange, lifecycle }: Props & {
  kind: "reject" | "suspend"; member: MemberRow; onOpenChange: (open: boolean) => void;
}) {
  const [reason, setReason] = useState("");
  const copy = kind === "reject" ? REJECT_DIALOG : SUSPEND_DIALOG;
  const run = kind === "reject" ? lifecycle.reject : lifecycle.suspend;
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      returnFocus={() => rowMenuOf(member.user_id)}
      title={copy.title(member.full_name)}
      description={copy.description}
      confirmLabel={copy.confirm}
      action={copy.action}
      notReady={!reason.trim()}
      onConfirm={() => run(member, reason)}
    >
      <Field>
        {/* Required, and said so (A11Y F3-18): the disabled button used to be the only cue. */}
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          <FieldLabel>{copy.reasonLabel}</FieldLabel>
          <span aria-hidden="true" className="text-sm text-text-secondary">{REQUIRED_MARK}</span>
        </span>
        <Input value={reason} required aria-required="true" onChange={(e) => setReason(e.target.value)} placeholder={copy.reasonPlaceholder} />
      </Field>
    </ConfirmDialog>
  );
}

function ReactivateDialog({ member, onOpenChange, lifecycle }: {
  member: MemberRow; onOpenChange: (open: boolean) => void; lifecycle: MemberLifecycle;
}) {
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      returnFocus={() => rowMenuOf(member.user_id)}
      title={REACTIVATE_DIALOG.title(member.full_name)}
      description={REACTIVATE_DIALOG.description}
      confirmLabel={REACTIVATE_DIALOG.confirm}
      action={REACTIVATE_DIALOG.action}
      tone="primary"
      onConfirm={() => lifecycle.reactivate(member)}
    />
  );
}

function ResetDialog({ member, onOpenChange, lifecycle, setDialog }: Props & {
  member: MemberRow; onOpenChange: (open: boolean) => void;
}) {
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      returnFocus={() => rowMenuOf(member.user_id)}
      title={RESET_DIALOG.title(member.full_name)}
      description={RESET_DIALOG.description(member.email)}
      confirmLabel={RESET_DIALOG.confirm}
      action={RESET_DIALOG.action}
      onConfirm={async () => {
        const result = await lifecycle.resetPassword(member);
        if (result) setDialog({ kind: "password", member, result });
      }}
    />
  );
}

/** Shown once: the temporary password, where it went, and what it can (and cannot) do. */
function PasswordDialog({ result, onClose }: { result: ResetResult; onClose: () => void }) {
  const toast = useToast();
  const copy = () => {
    void navigator.clipboard?.writeText(result.tempPassword);
    toast.push({ tone: "info", text: OUTCOMES.copied });
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{PASSWORD_DIALOG.title}</DialogTitle>
          <DialogDescription>
            {result.emailSentTo
              ? <>{`${PASSWORD_DIALOG.emailedTo} `}<strong className="text-text-primary">{result.emailSentTo}</strong>{". "}</>
              : <><strong className="text-text-primary">{PASSWORD_DIALOG.notEmailed}</strong>{PASSWORD_DIALOG.notEmailedRest}</>}
            {PASSWORD_DIALOG.scope}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="select-all rounded-xl border border-border bg-bg-muted px-4 py-3 text-center font-mono text-lg tracking-code text-text-primary">
            {result.tempPassword}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={copy} icon={<Copy aria-hidden="true" />}>{PASSWORD_DIALOG.copy}</Button>
          <Button onClick={onClose}>{PASSWORD_DIALOG.done}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
