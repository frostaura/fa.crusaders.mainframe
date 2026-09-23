import { Fingerprint, Info } from "@/components/ui/icons";
import { GET_STARTED } from "@/lib/onboardingCopy";
import { StepFrame } from "./StepFrame";

const COPY = GET_STARTED.steps.fingerprint;

/**
 * The court-box fingerprint, explained — never enrolled from here.
 *
 * <p>
 * Enrolment is admin-witnessed and member-present at the club's reader, consent first
 * (`biometric-abstraction.md` § Admin-led enrollment flow; the admin side is
 * `pages/admin/member/EnrolFingerDialog.tsx`). There is no remote path and no member endpoint,
 * so this step has nothing to press: it tells the member who to ask and what they will be
 * asked to agree to. A biometric surface, so no watermark.
 * </p>
 */
export function FingerprintStep({ focusOnMount }: { focusOnMount?: boolean }) {
  return (
    <StepFrame icon={Fingerprint} title={COPY.title} body={COPY.body} focusOnMount={focusOnMount}>
      <p className="flex items-start gap-2 rounded-lg bg-info-soft p-3 text-sm text-info-strong">
        <Info size={16} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0" />
        <span className="min-w-0">{COPY.tip}</span>
      </p>
      <p className="text-sm text-text-muted">{COPY.optional}</p>
    </StepFrame>
  );
}
