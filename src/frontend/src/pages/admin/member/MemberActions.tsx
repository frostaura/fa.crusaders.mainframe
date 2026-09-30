import { useState } from "react";
import { ActionsMenu, type ActionsMenuItem } from "@/components/admin/ActionsMenu";
import { useResetMemberCodeConfirm } from "@/components/member-code/useResetMemberCodeConfirm";
import { useToast } from "@/components/Toast";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { ArrowCounterClockwise, Envelope, Key, Prohibit, UserMinus, UserPlus } from "@/components/ui/icons";
import { Textarea } from "@/components/ui/textarea";
import { endpoints } from "@/lib/api";
import { ACTIONS_COPY as COPY, MEMBER_COPY } from "@/lib/memberDetailCopy";
import type { MemberDetail } from "@/lib/memberDetailApi";
import { transitionTruth } from "@/components/members/lostTransition";
import { REQUIRED_MARK } from "@/lib/confirmDialogCopy";

/**
 * The member's secondary actions behind one ⋯ (the founder: the old row of worded buttons was
 * "atrocious"). The two everyday actions — Top up, Book for member — stay on the header; the
 * lifecycle transitions live here, each behind a confirm dialog that states its consequence.
 *
 * <p>
 * <b>The lifecycle routes take the MEMBERSHIP id</b>, unlike everything else on this page. An
 * account with no membership row (a bootstrap admin) has no lifecycle, so those items are simply
 * absent for it rather than offered and refused.
 * </p>
 *
 * <p>
 * <b>A committed transition whose email failed says so.</b> `member_notified: false` means the
 * status changed and nobody told the member; a warning toast, never a success, never a failure.
 * </p>
 */
type Props = { detail: MemberDetail; name: string; onChanged: () => void | Promise<void> };

function ReasonField({ id, value, onChange }: { id: string; value: string; onChange: (next: string) => void }) {
  return (
    <Field controlId={id}>
      {/* Required, and said so (A11Y F3-18): the disabled button used to be the only cue. */}
      <span className="flex flex-wrap items-baseline gap-x-1.5">
          <FieldLabel>{COPY.reason}</FieldLabel>
          <span aria-hidden="true" className="text-sm text-text-secondary">{REQUIRED_MARK}</span>
        </span>
      <Textarea value={value} required aria-required="true" onChange={(e) => onChange(e.target.value)} placeholder={COPY.reasonPlaceholder} />
      <FieldDescription>{COPY.reasonHint}</FieldDescription>
    </Field>
  );
}

/** The toast for a lifecycle answer: success, or a warning when the member was not told. */
function useLifecycleToast() {
  const toast = useToast();
  return (notified: boolean, done: string, unnotified: string) =>
    toast.push(notified ? { tone: "success", text: done } : { tone: "warning", text: unnotified, durationMs: 8000 });
}

function useLifecycleItems({ detail, name, onChanged }: Props) {
  const say = useLifecycleToast();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const id = detail.membership_id;
  if (!id) return [];
  const settle = async () => { setReason(""); await onChanged(); };
  const reasonField = <ReasonField id="member-action-reason" value={reason} onChange={setReason} />;

  const approve: ActionsMenuItem = {
    label: COPY.approve, icon: <UserPlus aria-hidden="true" />,
    confirm: {
      title: COPY.approveTitle(name), description: COPY.approveBody, confirmLabel: COPY.approveConfirm, tone: "primary",
      action: COPY.approveAction,
      onConfirm: async () => {
        try {
          const r = await endpoints.adminApprove(id);
          say(r.member_notified, COPY.approved(name), COPY.approvedUnnotified(name));
        } catch (err) {
          // F3-3: ask the club before saying anything — the approval may have committed.
          const truth = await transitionTruth(detail.user_id, "Active", err);
          if (truth === "not_done") throw err;
          toast.push({ tone: "warning", text: truth === "done" ? COPY.approvedAfterLostReply(name) : COPY.approveUnknown(name), durationMs: 8000 });
        }
        await settle();
      },
    },
  };
  const reject: ActionsMenuItem = {
    label: COPY.reject, icon: <UserMinus aria-hidden="true" />, danger: true,
    confirm: {
      title: COPY.rejectTitle(name), description: COPY.rejectBody, confirmLabel: COPY.rejectConfirm,
      action: COPY.rejectAction, children: reasonField, notReady: !reason.trim(),
      onConfirm: async () => {
        const r = await endpoints.adminReject(id, reason.trim());
        say(r.member_notified, COPY.rejected(name), COPY.rejectedUnnotified(name));
        await settle();
      },
    },
  };
  const reactivate: ActionsMenuItem = {
    label: COPY.reactivate, icon: <ArrowCounterClockwise aria-hidden="true" />,
    confirm: {
      title: COPY.reactivateTitle(name), description: COPY.reactivateBody, confirmLabel: COPY.reactivateConfirm,
      tone: "primary", action: COPY.reactivateAction,
      onConfirm: async () => {
        const r = await endpoints.adminReactivate(id);
        say(r.member_notified, COPY.reactivated(name), COPY.reactivatedUnnotified(name));
        await settle();
      },
    },
  };
  const suspend: ActionsMenuItem = {
    label: COPY.suspend, icon: <Prohibit aria-hidden="true" />, danger: true,
    confirm: {
      title: COPY.suspendTitle(name), description: COPY.suspendBody, confirmLabel: COPY.suspendConfirm,
      action: COPY.suspendAction, children: reasonField, notReady: !reason.trim(),
      onConfirm: async () => {
        const r = await endpoints.adminSuspend(id, reason.trim());
        say(r.member_notified, COPY.suspended(name), COPY.suspendedUnnotified(name));
        await settle();
      },
    },
  };

  switch (detail.status) {
    case "PendingApproval": return [approve, reject];
    case "Active": return [suspend];
    case "Suspended": return [reactivate];
    case "Rejected": return [approve];
    default: return [];
  }
}

/** Reset member code, behind the ⋯ — the shared confirm (D8), absent for an account with no membership. */
function useResetCodeItem({ detail, name, onChanged }: Props): ActionsMenuItem | null {
  const confirm = useResetMemberCodeConfirm(name, detail.membership_id ?? "", onChanged);
  if (!detail.membership_id) return null;
  return { label: COPY.resetCode, icon: <Key aria-hidden="true" />, danger: true, confirm };
}

export function MemberActions(props: Props) {
  const { detail, name } = props;
  const toast = useToast();
  const lifecycle = useLifecycleItems(props);

  const resend: ActionsMenuItem | null = detail.email_verified ? null : {
    label: COPY.resendVerification, icon: <Envelope aria-hidden="true" />,
    onSelect: () => {
      endpoints.resendVerification(detail.email)
        .then(() => toast.push({ tone: "success", text: COPY.resent(detail.email) }))
        .catch(() => toast.push({ tone: "danger", text: COPY.resendFailed }));
    },
  };
  const resetCode = useResetCodeItem(props);

  return <ActionsMenu label={MEMBER_COPY.moreActions(name)} items={[resend, resetCode, ...lifecycle]} />;
}
