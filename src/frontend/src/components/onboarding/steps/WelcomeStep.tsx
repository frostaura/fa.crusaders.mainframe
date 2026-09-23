import { HandWaving } from "@/components/ui/icons";
import { GET_STARTED } from "@/lib/onboardingCopy";
import { StepFrame } from "./StepFrame";

const COPY = GET_STARTED.steps.welcome;

export function WelcomeStep({ focusOnMount }: { focusOnMount?: boolean }) {
  return <StepFrame icon={HandWaving} title={COPY.title} body={COPY.body} focusOnMount={focusOnMount} />;
}
