import { type ReactNode } from "react";
import { cn } from "../lib/utils";
import { typography } from "../lib/typography";
import { CrestMark } from "./shell/Crest";
import type { Icon } from "./ui/icons";

/**
 * The frame every screen a member meets before they have a session sits in — sign in, join,
 * confirm your address, forgot and reset your password, welcome — so they read as one product
 * belonging to one club.
 *
 * <p>
 * Before it, both sign-in and register were a bare white card on a near-white page: nothing said
 * squash and nothing said Crusaders, on the screen where a member decides whether to trust a page
 * with their password and a photograph of their face.
 * </p>
 *
 * <p>
 * <b>It owns the page's anatomy, not just its frame.</b> The crest band, the tin rule, the one
 * `h1` (`title`), its lead, an optional outcome mark above it, and a footer line under the card
 * ("New to the club? Register"). Seven screens used to each assemble their own heading out of
 * size, weight and margin, and no two agreed.
 * </p>
 *
 * <p>
 * <b>The band's ink, measured.</b> The subline was `text-brand-soft` — pale navy in the light
 * theme and near-black navy in the dark, because `brand.soft` is a SURFACE role that flips with
 * the theme while the band's navy (`brand.strong`) deliberately does not. In dark it painted dark
 * blue on blue at about 1.6:1. It is now `brand-ink` (white in both themes) at 85%, which
 * `AuthShell.test` composites onto the band and holds at ≥ 4.5:1 in both themes.
 * </p>
 */

/**
 * A squash singles court in plan view, drawn to the real proportions of the markings.
 *
 * Decorative and `aria-hidden`: it says "squash" to someone who can see it and is noise to
 * someone who cannot. LANDSCAPE, front wall on the left, because a band is wider than it is tall;
 * drawn portrait it had to be clipped to three disconnected rectangles that read as a fault. The
 * one red line is the tin.
 */
function CourtPlan({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 180 120" aria-hidden="true" focusable="false" className={className}>
      <rect x="1" y="1" width="178" height="118" rx="3" className="fill-none stroke-brand-ink/25" strokeWidth="1.5" />
      <line x1="112" y1="1" x2="112" y2="119" className="stroke-brand-ink/25" strokeWidth="1.5" />
      <line x1="112" y1="60" x2="179" y2="60" className="stroke-brand-ink/25" strokeWidth="1.5" />
      <rect x="112" y="1" width="38" height="38" className="fill-brand-ink/10 stroke-brand-ink/25" strokeWidth="1.5" />
      <rect x="112" y="81" width="38" height="38" className="fill-brand-ink/10 stroke-brand-ink/25" strokeWidth="1.5" />
      <line x1="9" y1="1" x2="9" y2="119" className="stroke-brand-tin" strokeWidth="4" strokeOpacity="0.85" strokeLinecap="round" />
    </svg>
  );
}

export type AuthMarkTone = "success" | "info" | "danger" | "brand";

const MARK_TONE: Record<AuthMarkTone, string> = {
  success: "bg-success-soft text-success-strong",
  info: "bg-info-soft text-info-strong",
  danger: "bg-danger-soft text-danger-strong",
  brand: "bg-accent-soft text-accent-strong",
};

/**
 * The outcome mark above a settled screen's title — "Check your inbox", "Email confirmed",
 * "That link didn't work". Shape as well as colour, so the tone survives forced colours.
 */
export function AuthMark({ icon: Glyph, tone }: { icon: Icon; tone: AuthMarkTone }) {
  return (
    <span aria-hidden="true" className={cn("mb-4 flex size-14 items-center justify-center rounded-full", MARK_TONE[tone])}>
      <Glyph size={28} weight="duotone" />
    </span>
  );
}

export type AuthShellProps = {
  /** One line under the club name saying what this account is FOR. */
  subline: string;
  /** The page's only `h1`. */
  title?: ReactNode;
  /** A sentence under the title — what this screen is for, or what happens next. */
  lead?: ReactNode;
  /** An `AuthMark` for a settled outcome, drawn above the title. */
  mark?: ReactNode;
  /** A line under the card: the way to the sibling screen ("Already have an account? Sign in"). */
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
};

function Band({ subline }: { subline: string }) {
  return (
    <div className="relative overflow-hidden bg-brand-strong px-5 py-5 sm:px-8 sm:py-6">
      {/*
        Wholly inside the band, never bled off the edge (bleeding it clipped away the short line
        and the service boxes, the only marks that make a rectangle read as a court). A fixed
        height rather than a percentage of the band, so a subline that wraps cannot grow the
        motif out of its column. Hidden on phones, where the club's name wants the width.
      */}
      <CourtPlan className="pointer-events-none absolute right-6 top-1/2 hidden h-16 w-auto -translate-y-1/2 opacity-60 sm:block" />
      <div className="relative flex items-center gap-3 sm:pr-32">
        {/* The crest's own navy vanishes into the band, leaving its white keyline and red
            cross — the mark as it would be embroidered on a navy shirt. */}
        <CrestMark />
        <div className="min-w-0">
          <p className="font-display text-xl font-bold tracking-tight text-brand-ink">Crusaders Squash Club</p>
          <p data-auth-subline="" className="mt-0.5 text-sm text-brand-ink/85">{subline}</p>
        </div>
      </div>
    </div>
  );
}

// Props destructured in the body: lizard counts each destructured name as a parameter (limit 6).
export function AuthShell(props: AuthShellProps) {
  const { subline, title, lead, mark, footer, children, className } = props;
  return (
    <div className={cn("mx-auto flex w-full max-w-narrow flex-col gap-5", className)}>
      <div className="overflow-hidden rounded-2xl border border-border bg-bg-surface shadow-md">
        <Band subline={subline} />
        {/*
          THE TIN RULE — the same line the club's email stationery carries under its masthead, so
          an email and a screen do not look like two different clubs. Decorative: aria-hidden,
          no text. `AuthShell.test` pins it, because it is exactly the mark a refactor loses.
        */}
        <div aria-hidden="true" className="h-1 bg-brand-tin" />
        <div className="px-5 py-6 sm:px-8 sm:py-8">
          {mark}
          {title ? <h1 className={cn(typography({ variant: "h1" }), "text-2xl sm:text-2xl")}>{title}</h1> : null}
          {lead ? <div className="mt-2 text-sm text-text-secondary">{lead}</div> : null}
          {children ? <div className={cn(title || lead ? "mt-6" : undefined)}>{children}</div> : null}
        </div>
      </div>
      {footer ? <div className="text-center text-sm text-text-secondary">{footer}</div> : null}
    </div>
  );
}

/** The "or" rule between two ways of doing the same thing. */
export function AuthDivider({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-xs font-medium text-text-muted">
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <span>{children}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  );
}
