import { useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { ActionsMenu, type ActionsMenuItem } from "@/components/admin/ActionsMenu";
import { useResetMemberCodeConfirm } from "@/components/member-code/useResetMemberCodeConfirm";
import { useToast } from "@/components/toastContext";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { ArrowCounterClockwise, Envelope, HourglassMedium, Key, Lock, Prohibit, ShieldCheck, ShieldWarning, Trash, UserMinus, UserPlus } from "@/components/ui/icons";
import { Textarea } from "@/components/ui/textarea";
import { endpoints } from "@/lib/api";
import { ACTIONS_COPY as COPY, ADMIN_ROLE_COPY, MEMBER_COPY } from "@/lib/memberDetailCopy";
import type { AdminRoleResult, MemberDetail } from "@/lib/memberDetailApi";
import { AdminRoleDialog } from "@/components/members/AdminRoleDialog";
import { DeleteMemberDialog } from "@/components/members/DeleteMemberDialog";
import { useMembersSplit } from "@/components/members/membersSplit";
import { DELETE_MEMBER_COPY } from "@/lib/deleteMemberCopy";
import { adminRoleOffer } from "@/components/members/adminRoleOffer";
import { transitionTruth } from "@/components/members/lostTransition";
import { REQUIRED_MARK } from "@/lib/confirmDialogCopy";

/**
 * The member's secondary actions behind one ⋯ (the founder: the old row of worded buttons was
 * "atrocious"). The two everyday actions — Sell package, Book for member — stay on the header; the
 * lifecycle transitions live here, each behind a confirm dialog that states its consequence.
 *
 * <p>
 * <b>The lifecycle routes take the MEMBERSHIP id</b>, unlike everything else on this page. An
 * account with no membership row (a bootstrap admin) has no lifecycle, so those items are simply
 * absent for it rather than offered and refused.
 * </p>
 *
 * <p>
 * <b>A committed transition whose email failed says so.</b> `member_email_queued: false` means the
 * status changed and nobody told the member; a warning toast, never a success, never a failure.
 * </p>
 */
type Props = { detail: MemberDetail; name: string; onChanged: () => void | Promise<void> };

/**
 * The header's ⋯ also takes the server's answer to a role change, so the badge redraws from it,
 * and opens "Adjust minutes" (P13 §3.7) — goodwill and corrections, kept off the header beside the
 * sale so a phone's header stays short, exactly as the members list keeps it in the row's ⋯.
 */
type ActionsProps = Props & { onRole: (result: AdminRoleResult) => void | Promise<void>; onAdjust?: () => void };

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

type LifecycleItems = Record<"approve" | "reject" | "reactivate" | "suspend", ActionsMenuItem>;

function useLifecycleItems({ detail, name, onChanged }: Props): LifecycleItems | null {
  const say = useLifecycleToast();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const id = detail.membership_id;
  if (!id) return null;
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
          say(r.member_email_queued, COPY.approved(name), COPY.approvedUnnotified(name));
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
        say(r.member_email_queued, COPY.rejected(name), COPY.rejectedUnnotified(name));
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
        say(r.member_email_queued, COPY.reactivated(name), COPY.reactivatedUnnotified(name));
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
        say(r.member_email_queued, COPY.suspended(name), COPY.suspendedUnnotified(name));
        await settle();
      },
    },
  };

  return { approve, reject, reactivate, suspend };
}

/** What the ⋯ holds for a status — an application's decision is on the header (MemberDecision), not here. */
function menuLifecycle(status: MemberDetail["status"], items: LifecycleItems | null): ActionsMenuItem[] {
  if (!items) return [];
  switch (status) {
    case "Active": return [items.suspend];
    case "Suspended": return [items.reactivate];
    default: return [];
  }
}

/** Reset member code, behind the ⋯ — the shared confirm (D8), absent for an account with no membership. */
function useResetCodeItem({ detail, name, onChanged }: Props): ActionsMenuItem | null {
  const confirm = useResetMemberCodeConfirm(name, detail.membership_id ?? "", onChanged);
  if (!detail.membership_id) return null;
  return { label: COPY.resetCode, icon: <Key aria-hidden="true" />, danger: true, confirm };
}

export function MemberActions(props: ActionsProps) {
  const { detail, name } = props;
  const toast = useToast();
  const lifecycle = menuLifecycle(detail.status, useLifecycleItems(props));
  const role = useRoleItem(props);
  const removal = useDeleteItem(props);
  const anchor = useRef<HTMLSpanElement>(null);

  const resend: ActionsMenuItem | null = detail.email_verified ? null : {
    label: COPY.resendVerification, icon: <Envelope aria-hidden="true" />,
    onSelect: () => {
      endpoints.resendVerification(detail.email)
        .then(() => toast.push({ tone: "success", text: COPY.resent(detail.email) }))
        .catch(() => toast.push({ tone: "danger", text: COPY.resendFailed }));
    },
  };
  const resetCode = useResetCodeItem(props);
  const adjust: ActionsMenuItem | null = props.onAdjust && detail.status === "Active"
    ? { label: MEMBER_COPY.adjust, icon: <HourglassMedium aria-hidden="true" />, onSelect: props.onAdjust }
    : null;

  return (
    // `contents`: the wrapper is only there to find the ⋯ again, for the role dialog's focus return.
    <span ref={anchor} data-member-actions="" className="contents">
      <ActionsMenu label={MEMBER_COPY.moreActions(name)} items={[adjust, resend, role.item, resetCode, ...lifecycle, removal.item]} />
      {role.attempt ? (
        <AdminRoleDialog
          key={role.attempt.n}
          userId={detail.user_id}
          name={name}
          grant={role.attempt.grant}
          open={role.open}
          onOpenChange={role.setOpen}
          returnFocus={() => anchor.current?.querySelector("button")}
          onChanged={props.onRole}
        />
      ) : null}
      {removal.attempt ? (
        <DeleteMemberDialog
          key={removal.attempt}
          userId={detail.user_id}
          name={name}
          open={removal.open}
          onOpenChange={removal.setOpen}
          returnFocus={() => anchor.current?.querySelector("button")}
          onDeleted={removal.done}
        />
      ) : null}
    </span>
  );
}

/**
 * Delete member, last in the ⋯ and in the danger ink (Dean, 2026-10-06: "should be able to delete
 * an account, not just suspend it"). Absent for an account with no membership — the bootstrap
 * administrator — and for one already deleted. After the delete the record is gone from the club's
 * lists, so the page goes back to Members, which reads the club again.
 */
function useDeleteItem({ detail }: ActionsProps) {
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const split = useMembersSplit();
  const offered = detail.membership_id !== null && detail.status !== "Deleted";
  const item: ActionsMenuItem | null = offered
    ? { label: DELETE_MEMBER_COPY.menu, icon: <Trash aria-hidden="true" />, danger: true, onSelect: () => { setAttempt((n) => n + 1); setOpen(true); } }
    : null;
  const done = () => {
    split?.onMemberDeleted?.();
    navigate(split?.listHref ?? MEMBER_COPY.backTo);
  };
  return { item, attempt, open, setOpen, done };
}

/**
 * Make administrator / Remove admin rights, on the record's header (R5 lane G — the plan put the
 * role control in the header, and Dean did not find it on the Sign-in tab). The SAME dialog the
 * Access tab's switch and the members list's ⋯ open; the switch's own rule decides what is offered
 * and why it is locked. Each press is a fresh dialog (a new key), so no reason is carried over.
 */
function useRoleItem({ detail }: ActionsProps) {
  // The direction is fixed at the press: the header redraws from the answer while the dialog closes.
  const [attempt, setAttempt] = useState<{ n: number; grant: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const offer = adminRoleOffer(detail.is_admin, detail.admin_source, detail.status);
  const item: ActionsMenuItem = {
    label: offer.grant ? ADMIN_ROLE_COPY.grantConfirm : ADMIN_ROLE_COPY.revokeConfirm,
    icon: offer.locked ? <Lock aria-hidden="true" /> : offer.grant ? <ShieldCheck aria-hidden="true" /> : <ShieldWarning aria-hidden="true" />,
    danger: !offer.grant && !offer.locked,
    disabled: offer.locked !== null,
    hint: offer.short ?? undefined,
    onSelect: () => { setAttempt((a) => ({ n: (a?.n ?? 0) + 1, grant: offer.grant })); setOpen(true); },
  };
  return { item, attempt, open, setOpen };
}

/**
 * An application's decision on the record's header (R4 form factor, SPEC §3.8): Approve and
 * Reject for a pending applicant, Approve for a turned-down one (A-2) — worded buttons beside the
 * name, each opening the same confirm the ⋯ used to, with the same lost-reply read-back. Nothing
 * for anyone else: their lifecycle stays behind the ⋯.
 */
export function MemberDecision(props: Props) {
  const items = useLifecycleItems(props);
  const status = props.detail.status;
  if (!items || (status !== "PendingApproval" && status !== "Rejected")) return null;
  return (
    <div data-member-decision="" className="-mt-4 flex flex-wrap items-center gap-2">
      <DecisionButton item={items.approve} variant={status === "Rejected" ? "outline" : "primary"} icon={<UserPlus aria-hidden="true" />} />
      {status === "PendingApproval" ? <DecisionButton item={items.reject} variant="danger-soft" icon={<UserMinus aria-hidden="true" />} /> : null}
    </div>
  );
}

function DecisionButton({ item, variant, icon }: { item: ActionsMenuItem; variant: "primary" | "outline" | "danger-soft"; icon: ReactNode }) {
  if (!item.confirm) return null;
  return (
    <ConfirmDialog
      {...item.confirm}
      trigger={<Button variant={variant} icon={icon} className="!h-auto min-h-touch flex-[1_1_auto] whitespace-normal py-2 sm:flex-none">{item.label}</Button>}
    />
  );
}
