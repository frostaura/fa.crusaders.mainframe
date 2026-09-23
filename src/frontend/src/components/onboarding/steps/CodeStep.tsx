import type { ReactNode } from "react";
import { QrCode } from "@/components/ui/icons";
import { TextLink } from "@/components/ui/text-link";
import { LANDING_PATH } from "@/components/shell/nav";
import { GET_STARTED } from "@/lib/onboardingCopy";
import { StepFrame } from "./StepFrame";

const COPY = GET_STARTED.steps.code;

/**
 * "Your one code" (R18, D1).
 *
 * <p>
 * <b>A description and a link, deliberately.</b> The single rotating code is generated on the
 * phone (P7), which another lane is building alongside this one; until it lands this step says
 * what the code is FOR and sends the member to My Code to see it. It is its own component so
 * P7 can put a live preview of the member's code here without touching the wizard around it —
 * pass it as `preview`. No watermark: the code is on the spec's never list.
 * </p>
 */
export function CodeStep({ focusOnMount, preview }: { focusOnMount?: boolean; preview?: ReactNode }) {
  return (
    <StepFrame icon={QrCode} title={COPY.title} body={COPY.body} focusOnMount={focusOnMount}>
      {preview ?? null}
      <TextLink variant="standalone" to={LANDING_PATH} className="self-start">{COPY.link}</TextLink>
    </StepFrame>
  );
}
