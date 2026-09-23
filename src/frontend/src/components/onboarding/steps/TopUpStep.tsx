import { Link } from "react-router-dom";
import { buttonVariants } from "@/components/ui/button";
import { Interactable } from "@/components/ui/interactable";
import { Wallet } from "@/components/ui/icons";
import { useBalance } from "@/lib/balance";
import { GET_STARTED } from "@/lib/onboardingCopy";
import { StepFrame } from "./StepFrame";

const COPY = GET_STARTED.steps.topup;

/** Top up — a link to the real top-up screen, carrying the large-CTA watermark. */
export function TopUpStep({ focusOnMount }: { focusOnMount?: boolean }) {
  const { balance } = useBalance();
  return (
    <StepFrame icon={Wallet} title={COPY.title} body={COPY.body} focusOnMount={focusOnMount}>
      {balance !== null ? <p className="text-sm font-semibold text-text-primary">{COPY.balance(balance)}</p> : null}
      <Interactable asChild surface="cta" watermark>
        <Link to="/wallet/topup" className={buttonVariants({ size: "lg", className: "self-start" })}>{COPY.cta}</Link>
      </Interactable>
    </StepFrame>
  );
}
