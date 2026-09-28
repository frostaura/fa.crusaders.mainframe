import type { ReactNode } from "react";
import { QrCode } from "@/components/ui/icons";
import { TextLink } from "@/components/ui/text-link";
import { LANDING_PATH } from "@/components/shell/nav";
import { GET_STARTED } from "@/lib/onboardingCopy";
import { CodePreview } from "@/components/member-code/CodePreview";
import { StepFrame } from "./StepFrame";

const COPY = GET_STARTED.steps.code;

/**
 * "Your one code" (R18, D1).
 *
 * <p>
 * <b>A description, a live preview and a link.</b> The single rotating code is made on the phone
 * (P7); the step shows the member's own code, rotating, through the `preview` slot — the
 * default is {@link CodePreview}, which enrols this phone exactly as a first visit to My Code
 * would — and sends them to My Code to hold it up. A caller may pass `preview={null}` to show
 * none. No watermark: the code is on the spec's never list.
 * </p>
 */
export function CodeStep({ focusOnMount, preview }: { focusOnMount?: boolean; preview?: ReactNode }) {
  return (
    <StepFrame icon={QrCode} title={COPY.title} body={COPY.body} focusOnMount={focusOnMount}>
      {preview === undefined ? <CodePreview /> : preview}
      <TextLink variant="standalone" to={LANDING_PATH} className="self-start">{COPY.link}</TextLink>
    </StepFrame>
  );
}
