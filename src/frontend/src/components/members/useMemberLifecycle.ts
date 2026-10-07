import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { useToast } from "@/components/toastContext";
import { endpoints } from "@/lib/api";
import { OUTCOMES } from "@/lib/membersCopy";
import type { MemberRow } from "./membersModel";
import { transitionTruth } from "./lostTransition";
import { focusAfterAction, pageHeading } from "@/lib/focusAfterAction";

export type ResetResult = { tempPassword: string; emailQueuedTo: string | null };

type Deps = {
  load: () => Promise<void>;
  /** Unused since D2 removed the in-place class change; kept so callers need not change. */
  setMembers?: Dispatch<SetStateAction<MemberRow[] | null>>;
};

/**
 * Every membership transition the list can start, each saying the TRUE thing afterwards.
 *
 * <p>
 * <b>Two different true things per transition.</b> The status change commits first; the email is
 * a consequence of it, and the API says which of the two happened (`member_email_queued`). So each
 * success has two sentences, and a failure reloads the club anyway.
 * </p>
 *
 * <p>
 * <b>The reload is in `finally`, whatever happened.</b> With SMTP refusing connections the API
 * once committed an approval and then answered 500; the admin read "Approval failed." about a
 * member who was already Active, and pressing Approve again answered 404. The screen shows what
 * the server says, not what the console hoped — and because the loader is what notifies the
 * chrome's pending badge, the two numbers move together.
 * </p>
 *
 * <p>
 * The dialog-driven ones (reject, suspend, reactivate, reset) THROW on failure so `ConfirmDialog`
 * keeps itself open and says why; Approve and Resend fire from the row and speak by toast. A
 * per-member in-flight guard sits under all of them: a double-click on Reactivate once sent a 200
 * and a 409, and the admin saw "active again" in green above "couldn't reactivate" in red.
 * </p>
 */
export function useMemberLifecycle({ load }: Deps) {
  const toast = useToast();
  const inFlight = useRef(new Set<string>());

  /** Run `work` once per key at a time; a second call while the first is out is ignored. */
  const once = useCallback(async <T,>(key: string, work: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current.has(key)) return undefined;
    inFlight.current.add(key);
    try { return await work(); } finally { inFlight.current.delete(key); }
  }, []);

  const approve = useCallback((m: MemberRow) => once(`approve:${m.user_id}`, async () => {
    try {
      const r = await endpoints.adminApprove(m.membership_id);
      toast.push(r.member_email_queued
        ? { tone: "success", text: OUTCOMES.approved(m.full_name) }
        : { tone: "warning", text: OUTCOMES.approvedUnnotified(m.full_name) });
    } catch (err) {
      // F3-3: a lost reply is asked about, not reported as a failure — the approval may have
      // committed before the connection dropped.
      const truth = await transitionTruth(m.user_id, "Active", err);
      if (truth === "done") toast.push({ tone: "warning", text: OUTCOMES.approvedAfterLostReply(m.full_name), durationMs: 8000 });
      else if (truth === "unknown") toast.push({ tone: "warning", text: OUTCOMES.approveUnknown(m.full_name), durationMs: 8000 });
      else toast.push({ tone: "danger", text: OUTCOMES.approveFailed });
    } finally {
      await load();
      // F3.20: the approved row leaves the Pending list and took focus with it, to <body>. The
      // keyboard goes to the next application's Approve — the queue's next step — or the heading.
      focusAfterAction(() => document.querySelector<HTMLElement>("[data-approve-row]") ?? pageHeading());
    }
  }), [load, once, toast]);

  const reject = useCallback((m: MemberRow, reason: string) => once(`reject:${m.user_id}`, async () => {
    try {
      const r = await endpoints.adminReject(m.membership_id, reason.trim());
      toast.push(r.member_email_queued
        ? { tone: "success", text: OUTCOMES.rejected }
        : { tone: "warning", text: OUTCOMES.rejectedUnnotified(m.full_name) });
    } finally {
      void load();
    }
  }), [load, once, toast]);

  const suspend = useCallback((m: MemberRow, reason: string) => once(`suspend:${m.user_id}`, async () => {
    try {
      const r = await endpoints.adminSuspend(m.membership_id, reason.trim());
      toast.push(r.member_email_queued
        ? { tone: "success", text: OUTCOMES.suspended(m.full_name) }
        : { tone: "warning", text: OUTCOMES.suspendedUnnotified(m.full_name) });
    } finally {
      void load();
    }
  }), [load, once, toast]);

  const reactivate = useCallback((m: MemberRow) => once(`reactivate:${m.user_id}`, async () => {
    try {
      const r = await endpoints.adminReactivate(m.membership_id);
      toast.push(r.member_email_queued
        ? { tone: "success", text: OUTCOMES.reactivated(m.full_name) }
        : { tone: "warning", text: OUTCOMES.reactivatedUnnotified(m.full_name) });
    } finally {
      void load();
    }
  }), [load, once, toast]);

  const resetPassword = useCallback(async (m: MemberRow): Promise<ResetResult | undefined> => once(`reset:${m.user_id}`, async () => {
    const r = await endpoints.adminResetMemberPassword(m.membership_id);
    toast.push(r.member_email_queued
      ? { tone: "success", text: OUTCOMES.reset(m.full_name) }
      : { tone: "warning", text: OUTCOMES.resetUnnotified(m.full_name) });
    return { tempPassword: r.temp_password, emailQueuedTo: r.email_queued_to };
  }), [once, toast]);

  /**
   * Send the verification email again. The endpoint answers the same way for an address it does
   * not hold, so the toast promises delivery to the address rather than confirming an account.
   * Once per member at a time: a resend spends any earlier unused link, so a double-click used to
   * send the member a dead link first.
   */
  const resend = useCallback((m: MemberRow) => once(`resend:${m.user_id}`, async () => {
    try {
      await endpoints.resendVerification(m.email);
      toast.push({ tone: "success", text: OUTCOMES.resendSent(m.email) });
    } catch {
      toast.push({ tone: "danger", text: OUTCOMES.resendFailed });
    }
  }), [once, toast]);

  return { approve, reject, suspend, reactivate, resetPassword, resend };
}

export type MemberLifecycle = ReturnType<typeof useMemberLifecycle>;
