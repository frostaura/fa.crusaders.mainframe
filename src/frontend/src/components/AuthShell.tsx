import { type ReactNode } from "react";
import { cn } from "../lib/utils";
import { typography } from "../lib/typography";
import { CrestMark } from "./shell/Crest";
import { AUTH_BRAND, AUTH_MAKER_LINE } from "../lib/authCopy";
import { Heart, type Icon } from "./ui/icons";

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
  /**
   * The card's column from `lg`: `form` (28rem) for a sign-in, `wide` (40rem) for an application
   * long enough to lay its photo beside its fields.
   */
  size?: "form" | "wide";
  children?: ReactNode;
  className?: string;
};

/**
 * R8 L8-8 — the band's side padding stops growing with the text at its normal-text pixels (20px,
 * 32px from `sm`), like the card's: at 320 / 200 % a 40px rem gutter a side, inside the page's 32px,
 * left the club's name 176px and broke it "Crusader / s".
 */
const BAND_GUTTER = { paddingInline: "min(var(--band-gutter), var(--band-gutter-px))" } as const;

function Band({ subline }: { subline: string }) {
  return (
    <div
      className="@container/band relative overflow-hidden bg-brand-strong py-5 [--band-gutter-px:20px] [--band-gutter:1.25rem] sm:py-6 sm:[--band-gutter-px:32px] sm:[--band-gutter:2rem]"
      style={BAND_GUTTER}
    >
      {/*
        Wholly inside the band, never bled off the edge (bleeding it clipped away the short line
        and the service boxes, the only marks that make a rectangle read as a court). A fixed
        height rather than a percentage of the band, so a subline that wraps cannot grow the
        motif out of its column. Drawn only when the band itself has the room (R9: by its own rem
        box, not the viewport) — hidden on phones, at large text and beside the brand panel.
      */}
      <CourtPlan className="pointer-events-none absolute right-6 top-1/2 hidden h-16 w-auto -translate-y-1/2 opacity-60 @[30rem]/band:block" />
      {/* R4 (V4-1): the name wraps under the crest when there is no room beside it (200 % text on
          a phone), rather than being cut by the band's edge. */}
      <div className="relative flex flex-wrap items-center gap-3 @[30rem]/band:pr-32">
        {/* The crest's own navy vanishes into the band, leaving its white keyline and red
            cross — the mark as it would be embroidered on a navy shirt. */}
        <CrestMark />
        <div className="min-w-0 flex-1 basis-40 break-words">
          {/* R8 L7-13: a step down when the TEXT is large for the band (a rem query), never a broken word. */}
          <p className="font-display text-xl font-bold tracking-tight text-brand-ink [@container_band_(max-width:14rem)]:text-lg">Crusaders Squash Club</p>
          <p data-auth-subline="" className="mt-0.5 text-sm text-brand-ink/85">{subline}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * The card's side padding: 1.25rem (2rem from `sm`), never more than its normal-text pixels. A
 * style over two custom properties, because utilities outside `ui/` may not use arbitrary spacing.
 */
const CARD_GUTTER = { paddingInline: "min(var(--auth-gutter), var(--auth-gutter-px))" } as const;

/**
 * One column (the card, 36rem) until the SHELL is 56rem wide; from there the brand panel beside
 * the card, the pair at the `wide` frame, stretched to the same height. The gutters are the page
 * shell's own — R8 L8-8: capped at their normal-text pixels, so 200 % text on a 320 phone gives
 * the card the width.
 *
 * R9 L9-1 — the split is the shell's OWN rem measure (`@container/authshell`), never `lg:`. At
 * 1024 or 1280 with 200 % text the viewport said "split" while a 28rem card (896px) and its 3rem
 * gap left the panel nothing: it ran under the card and broke "Crus / Squ / Club". In rem, large
 * text simply falls back to the one column; normal text at 1024 (60rem) still splits.
 */
const SHELL = [
  // A column that fills the frame's height, so the maker's line (`mt-auto`) sits at its foot.
  "@container/authshell flex w-full grow flex-col",
  "[--split-gutter-px:16px] [--split-gutter:1rem] sm:[--split-gutter-px:24px] sm:[--split-gutter:1.5rem]",
  "lg:[--split-gutter-px:32px] lg:[--split-gutter:2rem] 3xl:[--split-gutter-px:48px] 3xl:[--split-gutter:3rem]",
].join(" ");
const SPLIT =
  "mx-auto grid w-full max-w-narrow grid-cols-1 gap-8 pb-10 pt-6 @[56rem]/authshell:max-w-wide @[56rem]/authshell:items-stretch @[56rem]/authshell:gap-12 @[56rem]/authshell:py-10";
const SPLIT_GUTTER = { paddingInline: "min(var(--split-gutter), var(--split-gutter-px))" } as const;
const SPLIT_FORM = "@[56rem]/authshell:grid-cols-[minmax(0,1fr)_28rem]";
const SPLIT_WIDE = "@[56rem]/authshell:grid-cols-[minmax(0,1fr)_28rem] @[72rem]/authshell:grid-cols-[minmax(0,1fr)_40rem]";

// Props destructured in the body: lizard counts each destructured name as a parameter (limit 6).
export function AuthShell(props: AuthShellProps) {
  const { subline, title, lead, mark, footer, size = "form", children, className } = props;
  return (
    // `data-full-bleed`: the headerless frame stands down and this owns its width and gutters —
    // the card's 36rem on a phone, the split screen at 80rem once the shell is 56rem wide.
    <div data-full-bleed="" className={SHELL} style={SPLIT_GUTTER}>
      <div data-auth-shell="" className={cn(SPLIT, size === "wide" ? SPLIT_WIDE : SPLIT_FORM, className)}>
        <AuthColumns subline={subline} title={title} lead={lead} mark={mark} footer={footer}>{children}</AuthColumns>
      </div>
      <MakerLine />
    </div>
  );
}

/** Clear of the home indicator; at least the page's own 16px under the line. */
const MAKER_LINE_FOOT = { paddingBottom: "max(1rem, env(safe-area-inset-bottom))" } as const;

/**
 * "Made with ♥ by FrostAura" — one quiet line at the very foot of the signed-out screens, never on
 * the app's own pages. In the flow (`mt-auto` in a column that fills the frame), so it is pushed
 * below the card at a short height or 200 % text rather than ever sitting over the form. The heart
 * is decoration sized to the text and never crest red (tin is the crest's and the now-line's); the
 * line is read as "Made with love by FrostAura", and the maker's name is a link out.
 */
function MakerLine() {
  return (
    <p data-maker-line="" className="mt-auto pt-6 text-center text-xs text-text-muted" style={MAKER_LINE_FOOT}>
      <span className="sr-only">{`${AUTH_MAKER_LINE.spokenBefore} `}</span>
      <span aria-hidden="true">
        {AUTH_MAKER_LINE.before}{" "}
        <Heart size="1em" weight="fill" className="inline-block align-text-bottom text-accent-strong" />{" "}by{" "}
      </span>
      <a
        href={AUTH_MAKER_LINE.href}
        target="_blank"
        rel="noopener"
        className="no-lift rounded-sm font-medium text-text-secondary underline-offset-2 hover:underline"
      >
        {AUTH_MAKER_LINE.maker}
      </a>
    </p>
  );
}

/** The panel and the card's column — the shell's grid items. */
function AuthColumns(props: Omit<AuthShellProps, "size" | "className">) {
  const { subline, title, lead, mark, footer, children } = props;
  return (
    <>
      <BrandPanel />
      <div className="flex min-w-0 flex-col gap-5 @[56rem]/authshell:self-center">
        <div className="overflow-hidden rounded-2xl border border-border bg-bg-surface shadow-md">
          <Band subline={subline} />
          {/*
            THE TIN RULE — the same line the club's email stationery carries under its masthead, so
            an email and a screen do not look like two different clubs. Decorative: aria-hidden,
            no text. `AuthShell.test` pins it, because it is exactly the mark a refactor loses.
          */}
          <div aria-hidden="true" className="h-1 bg-brand-tin" />
          {/* R4: the side padding is capped at its normal-text pixels, so 200 % text on a 320px
              phone gives the words the width rather than 80px of gutter. */}
          <div
            className="@container/auth py-6 [--auth-gutter-px:20px] [--auth-gutter:1.25rem] sm:py-8 sm:[--auth-gutter-px:32px] sm:[--auth-gutter:2rem]"
            style={CARD_GUTTER}
          >
            {mark}
            {/* R8 L8-8: the title steps down when the text is large for the card (a rem query) —
                "password" ran into the card's edge at 320 / 200 %. */}
            {title ? <h1 className={cn(typography({ variant: "h1" }), "text-2xl sm:text-2xl [@container_auth_(max-width:14rem)]:text-xl")}>{title}</h1> : null}
            {lead ? <div className="mt-2 text-sm text-text-secondary">{lead}</div> : null}
            {children ? <div className={cn(title || lead ? "mt-6" : undefined)}>{children}</div> : null}
          </div>
        </div>
        {footer ? <div className="text-center text-sm text-text-secondary">{footer}</div> : null}
      </div>
    </>
  );
}

/**
 * The club beside the card (R4 form factor, SPEC 3.17): once the shell is 56rem wide a sign-in
 * screen is a split screen — the brand on the left, the form on the right — instead of one 512px
 * card floating in a 1920 canvas. Decoration and three sourced facts; nothing here is needed to
 * sign in, so it is not drawn at all in the one-column layout (the card keeps its own band with
 * the club's name), and the crest and court are aria-hidden.
 */
function BrandPanel() {
  return (
    <section
      aria-label={AUTH_BRAND.club}
      data-auth-brand=""
      className="relative hidden min-h-96 flex-col justify-between gap-10 overflow-hidden rounded-2xl bg-brand-strong p-10 text-brand-ink shadow-md @[56rem]/authshell:flex @[72rem]/authshell:p-12"
    >
      <div className="relative flex flex-col gap-4">
        <CrestMark className="h-20 w-auto self-start" />
        <p className="font-display text-4xl font-bold leading-tight tracking-tight">{AUTH_BRAND.club}</p>
        <p className="text-base text-brand-ink/85">{AUTH_BRAND.place}</p>
      </div>
      <CourtPlan className="pointer-events-none mx-auto h-auto w-full max-w-md opacity-80" />
      <ul aria-label={AUTH_BRAND.factsLabel} className="relative flex flex-col gap-3 border-t border-brand-ink/20 pt-6">
        {AUTH_BRAND.facts.map((fact) => (
          <li key={fact} className="flex items-center gap-3 text-base font-medium">
            <span aria-hidden="true" className="h-1 w-6 shrink-0 rounded-full bg-brand-tin" />
            <span className="min-w-0">{fact}</span>
          </li>
        ))}
      </ul>
    </section>
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
