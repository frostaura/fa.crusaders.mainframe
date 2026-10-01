import { Link } from "react-router-dom";
import { buttonVariants } from "@/components/ui/button";
import { Interactable } from "@/components/ui/interactable";
import { Wallet } from "@/components/ui/icons";
import { useBalance } from "@/lib/balance";
import { BUY_MINUTES_PATH, GET_STARTED } from "@/lib/onboardingCopy";
import { StepFrame } from "./StepFrame";

const COPY = GET_STARTED.steps.buy;

/**
 * Buy minutes — a link to the real buying screen (a package), carrying the large-CTA watermark.
 * P13: it was "top up" (in rand); the club sells minutes now, and a booking costs its
 * playing time, which the step says before anything else.
 */
export function BuyStep({ focusOnMount }: { focusOnMount?: boolean }) {
  const { balance } = useBalance();
  return (
    <StepFrame icon={Wallet} title={COPY.title} body={COPY.body} focusOnMount={focusOnMount}>
      {balance !== null ? <p className="text-sm font-semibold text-text-primary">{COPY.balance(balance)}</p> : null}
      <Interactable asChild surface="cta" watermark>
        <Link to={BUY_MINUTES_PATH} className={buttonVariants({ size: "lg", className: "self-start" })}>{COPY.cta}</Link>
      </Interactable>
    </StepFrame>
  );
}
