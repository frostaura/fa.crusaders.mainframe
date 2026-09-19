import { type ReactNode } from "react";
import { cn } from "../lib/utils";

/**
 * The frame both sign-in and register sit in, so they read as one product belonging to one club.
 *
 * <p>
 * Before this, both screens were a bare white card on a near-white page. Nothing on either said
 * squash, nothing said Crusaders, and the club's name appeared only as a grey caption under the
 * word "Sign in". They could have been the login for any SaaS product in the world, which for
 * the screen where a member decides whether to trust a page with their password and a photograph
 * of their face is the wrong thing to be.
 * </p>
 *
 * <p>
 * It is a sibling of <c>Card</c> rather than a use of it: Card's <c>p-4 sm:p-6</c> cannot host a
 * full-bleed band, and overriding padding from outside is how a shared primitive stops meaning
 * anything. It reuses Card's surface classes verbatim so the two cannot drift apart visually.
 * </p>
 *
 * <p>
 * It deliberately does NOT touch <c>Layout</c>. Layout's headerless branch is shared with
 * verify-email, welcome, forgot-password, reset-password and change-password; restructuring it
 * to suit these two screens would silently move five others. AuthShell lives inside that branch
 * and owns nothing above itself.
 * </p>
 */

/**
 * A squash singles court in plan view, drawn to the real proportions of the markings.
 *
 * Decorative and <c>aria-hidden</c>: it says "squash" to someone who can see it and is noise to
 * someone who cannot. The one red line is the tin, which is where the club's second colour
 * genuinely belongs.
 */
function CourtPlan({ className }: { className?: string }) {
  return (
    // LANDSCAPE, with the front wall on the left. Drawn portrait — the orientation a court plan
    // is normally printed in — it had to be scaled past the band's height to be any size at all,
    // and what survived the clip was three disconnected rectangles that read as a rendering
    // fault. A band is wider than it is tall, so the motif has to be too.
    <svg viewBox="0 0 180 120" aria-hidden="true" focusable="false" className={className}>
      <rect x="1" y="1" width="178" height="118" rx="3"
            className="fill-none stroke-brand-ink/25" strokeWidth="1.5" />
      {/* Short line, then the half-court line running back from it to the rear wall. */}
      <line x1="112" y1="1" x2="112" y2="119" className="stroke-brand-ink/25" strokeWidth="1.5" />
      <line x1="112" y1="60" x2="179" y2="60" className="stroke-brand-ink/25" strokeWidth="1.5" />
      {/* The two service boxes, behind the short line. */}
      <rect x="112" y="1" width="38" height="38" className="fill-brand-ink/10 stroke-brand-ink/25" strokeWidth="1.5" />
      <rect x="112" y="81" width="38" height="38" className="fill-brand-ink/10 stroke-brand-ink/25" strokeWidth="1.5" />
      {/* The tin, down the front wall — the one red line on a squash court. */}
      <line x1="9" y1="1" x2="9" y2="119" className="stroke-brand-tin" strokeWidth="4" strokeOpacity="0.85" strokeLinecap="round" />
    </svg>
  );
}

export type AuthShellProps = {
  /** One line under the club name saying what this account is FOR. */
  subline: string;
  children: ReactNode;
  className?: string;
};

export function AuthShell({ subline, children, className }: AuthShellProps) {
  return (
    <div className={cn("w-full max-w-md mx-auto", className)}>
      <div className="bg-bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
        <div className="relative overflow-hidden bg-brand-strong px-5 py-6 sm:px-6 sm:py-7">
          {/*
            WHOLLY inside the band, not bled off the edge. Bleeding it clipped away the short
            line and both service boxes — which are the only marks that make a rectangle read as
            a squash court — leaving a red line and two grey bars that looked like a broken
            image. Small and complete beats large and amputated.

            Hidden below sm, where the club's name wants the full width more than the texture
            does.
          */}
          <CourtPlan className="pointer-events-none absolute right-5 top-1/2 hidden h-[74%] w-auto -translate-y-1/2 opacity-55 sm:block" />
          {/* The right padding reserves the motif's column so a longer subline wraps instead of
              running underneath it. It applies only at sm+, which is exactly where the motif is
              rendered. */}
          <div className="relative sm:pr-36">
            <p className="text-lg font-semibold tracking-tight text-brand-ink">Crusaders Squash Club</p>
            <p className="mt-1 text-sm text-brand-soft">{subline}</p>
          </div>
        </div>
        <div className="px-5 py-6 sm:px-6 sm:py-7">{children}</div>
      </div>
    </div>
  );
}
