import { ShieldCheck } from "@/components/ui/icons";
import { PrivacySwitches } from "@/components/players/privacy/PrivacySwitches";
import { GET_STARTED } from "@/lib/onboardingCopy";
import { StepFrame } from "./StepFrame";

const COPY = GET_STARTED.steps.privacy;

/**
 * D13 — the last step: who can find you. The same two switches Profile's Privacy card shows,
 * both off unless the member turns them on. Nothing here is required; Finish works either way.
 */
export function PrivacyStep({ focusOnMount }: { focusOnMount?: boolean }) {
  return (
    <StepFrame icon={ShieldCheck} title={COPY.title} body={COPY.body} focusOnMount={focusOnMount}>
      <PrivacySwitches />
    </StepFrame>
  );
}
