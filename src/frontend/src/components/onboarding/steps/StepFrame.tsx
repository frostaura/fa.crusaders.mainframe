import { useEffect, useRef, type ReactNode } from "react";
import type { Icon } from "@/components/ui/icons";
import { typography } from "@/lib/typography";
import { cn } from "@/lib/utils";

/**
 * One step of the welcome wizard: the 64px duotone tile the design system reserves for
 * onboarding, the step's own `h2`, its sentences, and whatever the step does.
 *
 * <p>
 * <b>Focus follows the step.</b> The steps change inside one route, so the route announcer
 * never fires; without this a screen-reader user pressing Next would hear nothing and stay on
 * the button. The heading takes focus on every step after the first render — never on the
 * first, which the route announcer already handles by focusing the page's `h1`.
 * </p>
 */
export type StepFrameProps = {
  icon: Icon;
  title: string;
  body: readonly string[];
  /** False on the step the page opened at. */
  focusOnMount?: boolean;
  children?: ReactNode;
};

export function StepFrame(props: StepFrameProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { icon: Tile, title, body, focusOnMount = true, children } = props;
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focusOnMount) heading.current?.focus({ preventScroll: false });
  }, [focusOnMount]);

  return (
    <section data-onboarding-step="" aria-labelledby="onboarding-step-title" className="flex flex-col gap-4">
      <span
        aria-hidden="true"
        className="inline-flex size-20 items-center justify-center self-start rounded-2xl bg-accent-soft text-accent-strong"
      >
        <Tile size={64} weight="duotone" />
      </span>
      <h2 id="onboarding-step-title" ref={heading} tabIndex={-1} className={cn(typography({ variant: "h2" }), "break-words")}>
        {title}
      </h2>
      <div className="flex max-w-prose flex-col gap-3 text-base text-text-secondary">
        {body.map((line) => <p key={line}>{line}</p>)}
      </div>
      {children}
    </section>
  );
}
