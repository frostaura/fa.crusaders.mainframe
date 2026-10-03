import { Link } from "react-router-dom";
import { buttonVariants } from "@/components/ui/button-variants";
import { Interactable } from "@/components/ui/interactable";
import { CalendarBlank } from "@/components/ui/icons";
import { GET_STARTED } from "@/lib/onboardingCopy";
import { StepFrame } from "./StepFrame";

const COPY = GET_STARTED.steps.book;

/** The first booking — a link to the grid, which is where booking is done. */
export function BookStep({ focusOnMount }: { focusOnMount?: boolean }) {
  return (
    <StepFrame icon={CalendarBlank} title={COPY.title} body={COPY.body} focusOnMount={focusOnMount}>
      <Interactable asChild surface="cta" watermark>
        <Link to="/bookings" className={buttonVariants({ size: "lg", className: "self-start" })}>{COPY.cta}</Link>
      </Interactable>
    </StepFrame>
  );
}
