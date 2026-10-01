import { useEffect, useReducer, useState, type ComponentType } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { Progress } from "@/components/ui/progress";
import { LANDING_PATH } from "@/components/shell/nav";
import { useOnboarding } from "@/components/onboarding/useOnboarding";
import { BookStep } from "@/components/onboarding/steps/BookStep";
import { CodeStep } from "@/components/onboarding/steps/CodeStep";
import { InstallStep } from "@/components/onboarding/steps/InstallStep";
import { PasskeyStep } from "@/components/onboarding/steps/PasskeyStep";
import { PrivacyStep } from "@/components/onboarding/steps/PrivacyStep";
import { TopUpStep } from "@/components/onboarding/steps/TopUpStep";
import { WelcomeStep } from "@/components/onboarding/steps/WelcomeStep";
import {
  currentStep, initialWizard, isLastStep, isMemberStep, markOffered, memberSteps, startingStep, wizardReducer,
  type MemberStepId,
} from "@/lib/onboarding";
import { GET_STARTED } from "@/lib/onboardingCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";

/**
 * `/get-started` — the member welcome wizard (P8, R14, D3).
 *
 * <p>
 * <b>Skippable, resumable, reopenable.</b> "Skip for now" is on every step and records a
 * dismissal, so the first-run gate stops offering it; every step reached is recorded as the
 * resume point, on this device first and on the server behind it; the account menu's "Replay
 * welcome" and the checklist on My Code both reopen it. A step never blocks the next: Next is
 * always live, because every step here is something a member MAY do, not something they must.
 * </p>
 *
 * <p>
 * <b>Where it resumes.</b> The device mirror answers at once; the server's last step can arrive
 * a moment later with the profile. When either arrives and the member has not moved yet, the
 * wizard jumps to the furthest of them — once — so a member who started on another phone picks
 * up where they left off without the page waiting on a read that may never come (offline).
 * </p>
 */

const STEP_VIEWS: Partial<Record<MemberStepId, ComponentType<{ focusOnMount?: boolean }>>> = {
  welcome: WelcomeStep,
  code: CodeStep,
  passkey: PasskeyStep,
  topup: TopUpStep,
  book: BookStep,
  install: InstallStep,
  privacy: PrivacyStep,
};

function useStartingStep() {
  const onboarding = useOnboarding();
  const [params] = useSearchParams();
  const requested = params.get("step");
  const replay = params.has("replay");
  const [initial] = useState(() => startingStep({ requested, replay, last: onboarding.local.lastStep }));
  // The device's and the server's resume points can each arrive after the first render (the
  // session and the profile are still being read). The furthest of the two wins — the member
  // reached at least that far somewhere — and only when nothing more specific was asked for.
  const adoptTarget = requested || replay
    ? null
    : furthest([onboarding.local.lastStep, onboarding.prefs?.member_onboarding_last_step]);
  return { onboarding, initial, adoptTarget };
}

function furthest(candidates: Array<string | null | undefined>): MemberStepId | null {
  const steps = memberSteps();
  const known = candidates.filter(isMemberStep);
  if (known.length === 0) return null;
  return known.reduce((a, b) => (steps.indexOf(b) > steps.indexOf(a) ? b : a));
}

export default function GetStartedPage() {
  const { onboarding, initial, adoptTarget } = useStartingStep();
  const [state, dispatch] = useReducer(wizardReducer, initial, initialWizard);
  const step = currentStep(state);
  const { saveStep, userId } = onboarding;

  useEffect(() => { markOffered(userId); }, [userId]);
  // Only once the member has moved: saving the step the page OPENED at would overwrite a
  // resume point on the server that had not reached this device yet.
  useEffect(() => { if (state.touched) saveStep(step); }, [saveStep, step, state.touched]);
  useEffect(() => {
    if (adoptTarget) dispatch({ type: "adopt", step: adoptTarget });
  }, [adoptTarget]);

  const View = STEP_VIEWS[step];
  const go = (action: "next" | "back") => dispatch({ type: action });

  return (
    <PageShell width="narrow">
      <PageHeader title={GET_STARTED.title} description={GET_STARTED.description} />
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold text-text-secondary" data-onboarding-progress="">
          {GET_STARTED.stepOf(state.index + 1, state.steps.length)}
        </p>
        <Progress value={state.index + 1} max={state.steps.length} aria-label={GET_STARTED.stepOf(state.index + 1, state.steps.length)} />
      </div>
      <div className="rounded-2xl border border-border bg-bg-surface p-4 shadow-xs sm:p-6">
        {View ? <View key={step} focusOnMount={state.touched} /> : null}
      </div>
      <WizardFooter first={state.index === 0} last={isLastStep(state)} onMove={go} />
    </PageShell>
  );
}

function WizardFooter({ first, last, onMove }: { first: boolean; last: boolean; onMove: (action: "next" | "back") => void }) {
  const { complete, dismiss } = useOnboarding();
  const navigate = useNavigate();
  const toast = useToast();
  const leave = () => navigate(LANDING_PATH);
  // The device mirror is written before either POST, so a failure still leaves the member's
  // choice honoured on this phone — the toast says that much and no more.
  const options = {
    success: leave,
    failure: () => {
      toast.push({ tone: "info", text: GET_STARTED.savedHereOnly });
      leave();
    },
  };
  const finish = useAsyncAction(complete, options);
  const skip = useAsyncAction(dismiss, options);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Button variant="ghost" pending={skip.pending} onClick={() => void skip.run()} className="sm:mr-auto">
        {GET_STARTED.skip}
      </Button>
      {!first ? <Button variant="outline" onClick={() => onMove("back")}>{GET_STARTED.back}</Button> : null}
      {last ? (
        <Button pending={finish.pending} onClick={() => void finish.run()}>{GET_STARTED.finish}</Button>
      ) : (
        <Button onClick={() => onMove("next")}>{GET_STARTED.next}</Button>
      )}
    </div>
  );
}
