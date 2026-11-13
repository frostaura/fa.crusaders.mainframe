import type { ReactNode } from "react";
import { unsureSentence, writeOrReadBack } from "@/lib/lostReply";
import { LOST_REPLY, unsureWords } from "@/lib/lostReplyCopy";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { AdminRoleSwitch } from "@/components/members/AdminRoleSwitch";
import { EmailWithBreaks } from "@/components/members/EmailWithBreaks";
import { useToast } from "@/components/toastContext";
import { Button } from "@/components/ui/button";
import { Envelope, Fingerprint, Key, Password, Trash } from "@/components/ui/icons";
import { Section } from "@/components/ui/page-shell";
import { clubDate } from "@/lib/clubClock";
import { endpoints } from "@/lib/api";
import { FEATURES } from "@/lib/features";
import type { AdminRoleResult, FingerprintEnrolment, MemberDetail } from "@/lib/memberDetailApi";
import { ACCESS_COPY as COPY, ACTIONS_COPY, fingerLabel } from "@/lib/memberDetailCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { EnrolFingerDialog } from "./EnrolFingerDialog";
import { ResetPasswordControl } from "./ResetPasswordControl";
import { zoneNow } from "./memberTime";
import { useMemberDetail } from "./useMemberDetail";

/**
 * Sign-in & biometrics — how this person gets in: admin rights (R20), passkeys, their email
 * verification and password, and — while `FEATURES.fingerprintEnrolment` is on (P13 §9) — the
 * fingerprints the court boxes hold for them. The box does not read fingerprints yet, so the
 * section is not drawn and no enrolment can be reached; the backend keeps its endpoints.
 *
 * <p>
 * Every control here changes what a person can DO, so each one is a confirm dialog or a flow
 * that states its consequence first, and every change re-reads the member so the header above
 * (the Administrator badge, the counts) never disagrees with this tab.
 * </p>
 */
export function MemberAccess() {
  const { detail, name, userId, reload, patch } = useMemberDetail();
  const onRole = async (result: AdminRoleResult) => {
    patch({ is_admin: result.is_admin, admin_source: result.admin_source });
    await reload();
  };
  return (
    <div className="flex flex-col gap-8">
      <Section title={COPY.adminTitle} description={COPY.adminDescription}>
        <Panel>
          <AdminRoleSwitch
            userId={userId}
            name={name}
            isAdmin={detail.is_admin}
            adminSource={detail.admin_source}
            status={detail.status}
            onChanged={onRole}
          />
        </Panel>
      </Section>
      <Section title={COPY.signInTitle} description={COPY.signInDescription}>
        <SignIn detail={detail} name={name} />
      </Section>
      {FEATURES.fingerprintEnrolment ? (
        <Section
          title={COPY.fingerprintsTitle}
          description={COPY.fingerprintsDescription}
          actions={<EnrolFingerDialog userId={userId} name={name} used={detail.fingerprints.enrolments} onEnrolled={reload} />}
        >
          <Fingerprints enrolments={detail.fingerprints.enrolments} onRemoved={reload} />
        </Section>
      ) : null}
    </div>
  );
}

/** A row's action may take two lines rather than run off a 320 phone at 200 % text (R5 F5-3). */
const WRAPS = "!h-auto min-h-touch max-w-full whitespace-normal py-2 text-center";

function Panel({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4 rounded-xl border border-border bg-bg-surface p-4 sm:p-6">{children}</div>;
}

/** One line of the sign-in panel: an icon, what is true, and the action that changes it. */
function Row({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b border-border py-4 first:pt-0 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 shrink-0 text-text-secondary">{icon}</span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="font-semibold text-text-primary">{title}</p>
          {/* Breaks (R5 F5-3): a long verified address had no break and scrolled the tab sideways at 390. */}
          <div className="min-w-0 break-words text-sm text-text-secondary">{children}</div>
        </div>
      </div>
      {action ? <div className="min-w-0 max-w-full sm:shrink-0">{action}</div> : null}
    </div>
  );
}

function SignIn({ detail, name }: { detail: MemberDetail; name: string }) {
  const toast = useToast();
  const resend = useAsyncAction(() => endpoints.resendVerification(detail.email), {
    success: () => toast.push({ tone: "success", text: ACTIONS_COPY.resent(detail.email) }),
    toast: { failure: ACTIONS_COPY.resendFailed },
  });
  return (
    <Panel>
      <div>
        <Row icon={<Key aria-hidden="true" />} title={COPY.passkeys}>
          {detail.passkey_count > 0 ? COPY.passkeysSome(detail.passkey_count) : COPY.passkeysNone}
        </Row>
        <Row
          icon={<Envelope aria-hidden="true" />}
          title={detail.email_verified ? COPY.emailVerified : COPY.emailUnverifiedTitle}
          action={detail.email_verified ? null : (
            <Button variant="outline" className={WRAPS} pending={resend.pending} onClick={() => void resend.run()}>{COPY.resend}</Button>
          )}
        >
          {detail.email_verified ? <EmailWithBreaks email={detail.email} /> : COPY.emailUnverifiedHint}
        </Row>
        <Row
          icon={<Password aria-hidden="true" />}
          title={COPY.password}
          action={detail.membership_id ? <ResetPasswordControl membershipId={detail.membership_id} name={name} email={detail.email} /> : null}
        >
          {detail.membership_id ? COPY.passwordHint : COPY.noMembershipNote}
        </Row>
      </div>
    </Panel>
  );
}

function Fingerprints({ enrolments, onRemoved }: { enrolments: FingerprintEnrolment[]; onRemoved: () => Promise<void> }) {
  const zone = zoneNow();
  if (enrolments.length === 0) {
    return (
      <Panel>
        <p className="flex items-center gap-3 text-sm text-text-secondary">
          <Fingerprint size={20} aria-hidden="true" />
          {COPY.fingerprintsNone}
        </p>
      </Panel>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-bg-surface [&_:focus-visible]:-outline-offset-2">
      {enrolments.map((e) => (
        <li key={e.template_id} className="flex items-center gap-3 px-4 py-3">
          <Fingerprint size={20} aria-hidden="true" className="shrink-0 text-accent-strong" />
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="font-semibold text-text-primary">{fingerLabel(e.finger_label)}</p>
            <p className="text-sm text-text-secondary">{COPY.enrolled(clubDate(e.enrolled_at, zone))}</p>
          </div>
          <RemoveFinger enrolment={e} onRemoved={onRemoved} />
        </li>
      ))}
    </ul>
  );
}

function RemoveFinger({ enrolment, onRemoved }: { enrolment: FingerprintEnrolment; onRemoved: () => Promise<void> }) {
  const toast = useToast();
  const finger = fingerLabel(enrolment.finger_label);
  return (
    <ConfirmDialog
      trigger={(
        <Button variant="ghost" size="sm" icon={<Trash aria-hidden="true" />} aria-label={COPY.remove(finger)}>
          {COPY.removeShort}
        </Button>
      )}
      title={COPY.removeTitle(finger)}
      description={COPY.removeBody}
      confirmLabel={COPY.removeConfirm}
      action={COPY.removeAction}
      // FA-11: a lost reply is read back from the enrolments — gone means it was removed.
      describe={(e) => unsureSentence(e, unsureWords("the fingerprint may still be enrolled", "the fingerprint was removed", "this tab"))}
      onConfirm={async () => {
        const { proven, answered } = await writeOrReadBack(
          async () => { await endpoints.adminBiometricRemoveTemplate(enrolment.template_id); return {}; },
          async () => ((await endpoints.adminBiometricEnrollments())
            .some((r) => r.templates.some((t) => t.template_id === enrolment.template_id)) ? null : {}),
        );
        toast.push({ tone: "success", text: proven ? LOST_REPLY.proven(COPY.removed, answered) : COPY.removed });
        await onRemoved();
      }}
    />
  );
}

