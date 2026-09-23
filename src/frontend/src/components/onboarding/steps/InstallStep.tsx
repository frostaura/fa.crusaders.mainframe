import { Button } from "@/components/ui/button";
import { CheckCircle, DeviceMobile, Envelope, Export } from "@/components/ui/icons";
import { installRoute, promptInstall, useInstallState, type InstallRoute } from "@/lib/installPrompt";
import { GET_STARTED } from "@/lib/onboardingCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { useOnboarding } from "../useOnboarding";
import { StepFrame } from "./StepFrame";

const COPY = GET_STARTED.steps.install;

/**
 * Install the app, and where the club's messages arrive.
 *
 * <p>
 * The install half says one of four things (`lib/installPrompt.ts`): installed already, the
 * browser's own Install button, the iPhone Share → Add to Home Screen route in words, or that
 * this browser cannot install and does not need to. The notification half says email, because
 * that is the product's channel — every player-affecting event sends one — and there is no push.
 * </p>
 */
export function InstallStep({ focusOnMount }: { focusOnMount?: boolean }) {
  const onboarding = useOnboarding();
  const state = useInstallState();
  const route = installRoute({
    standalone: state.standalone,
    installed: state.installedNow || onboarding.local.installed === true,
    canPrompt: state.canPrompt,
    ios: state.ios,
  });
  const install = useAsyncAction(promptInstall, {
    success: (accepted) => { if (accepted) onboarding.markInstalled(); },
  });

  return (
    <StepFrame icon={DeviceMobile} title={COPY.title} body={COPY.body} focusOnMount={focusOnMount}>
      <InstallRouteBlock route={route} pending={install.pending} onInstall={() => void install.run()} />
      <div className="flex items-start gap-3 rounded-xl border border-border bg-bg-muted p-4">
        <Envelope size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-text-secondary" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">{COPY.emailTitle}</p>
          <p className="text-sm text-text-secondary">{COPY.email}</p>
        </div>
      </div>
    </StepFrame>
  );
}

function InstallRouteBlock({ route, pending, onInstall }: { route: InstallRoute; pending: boolean; onInstall: () => void }) {
  if (route === "installed") {
    return (
      <p className="flex items-center gap-2 text-sm font-semibold text-success-strong">
        <CheckCircle size={20} weight="fill" aria-hidden="true" className="shrink-0" />
        {COPY.installed}
      </p>
    );
  }
  if (route === "prompt") {
    return (
      <Button size="lg" className="self-start" onClick={onInstall} pending={pending} icon={<DeviceMobile aria-hidden="true" />}>
        {COPY.prompt}
      </Button>
    );
  }
  if (route === "ios") {
    const [intro, ...steps] = COPY.ios;
    return (
      <div className="flex flex-col gap-2 text-sm text-text-primary">
        <p className="font-semibold">{intro}</p>
        <ol className="flex list-decimal flex-col gap-1 pl-5">
          {steps.map((line, index) => (
            <li key={line}>
              {line}
              {index === 0 ? <Export size={16} aria-hidden="true" className="ml-1 inline align-text-bottom text-accent-strong" /> : null}
            </li>
          ))}
        </ol>
      </div>
    );
  }
  return <p className="text-sm text-text-secondary">{COPY.browser}</p>;
}
