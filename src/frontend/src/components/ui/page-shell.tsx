import { useId, type ComponentProps, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { typography } from "@/lib/typography";
import { CaretLeft } from "./icons";

/**
 * The page shell (design-system.md, Patterns → Page shell). Every page is
 * `<PageShell width><PageHeader/><Section/>…</PageShell>`, and no page sets its own root
 * width, gutters, top padding or section gap — the product once had a different answer to each
 * of those on nearly every screen, and it read as eight apps in one.
 *
 * <ul>
 *   <li><b>narrow</b> 36rem — ONLY single-task, linear pages: auth forms, change password, top up
 *   and its status, not found. Never a screen with more than one thing on it (R4 form factor:
 *   My Code, Inbox, Invites and Profile sat in a 512px column with 73 % of a 1920 screen empty).</li>
 *   <li><b>content</b> 64rem — the default.</li>
 *   <li><b>wide</b> 80rem — member screens with an aside or a split view, the booking grid —
 *   and the `full` frame from 3xl (R6 L6-10: at 1920 an 80rem member screen left a third of the
 *   window empty, and the app bar jumped 320px between it and Bookings, which already widened).</li>
 *   <li><b>full</b> 120rem (`max-w-page`) — admin and data screens; never unbounded.</li>
 * </ul>
 * <p>
 * Gutters `px-4 sm:px-6 lg:px-8 3xl:px-12`, top `pt-6 lg:pt-8`, 32px between sections. The header
 * sits 24px above the body (it pulls the 32px gap in by 8px), per the spacing table.
 * </p>
 *
 * <p>
 * <b>The shell is the page's container</b> (`@container/page`): a layout inside it asks how wide
 * the PAGE is, not the viewport, which lies beside the admin rail. The app bar follows a `full`
 * shell's frame from 3xl by `:has()` (AppShell), so the crest and the content share one edge.
 * </p>
 */
export type PageWidth = "narrow" | "content" | "wide" | "full";

const WIDTH: Record<PageWidth, string> = {
  narrow: "max-w-narrow",
  content: "max-w-content",
  wide: "max-w-wide",
  full: "max-w-page",
};

export type PageShellProps = ComponentProps<"div"> & {
  width?: PageWidth;
  /**
   * Widen to the `full` frame (120rem) from 3xl. On by default for `wide` (R6 L6-10); a `content`
   * screen may ask for it, and a `wide` one may decline it with `false`.
   */
  fullFrom3xl?: boolean;
};

export function PageShell({ width = "content", fullFrom3xl: asked, className, children, ...rest }: PageShellProps) {
  const fullFrom3xl = asked ?? width === "wide";
  return (
    <div
      data-page-shell={width}
      // What the app bar follows from 3xl (AppShell reads it by :has()).
      data-page-frame={width === "full" || fullFrom3xl ? "full" : undefined}
      className={cn("@container/page mx-auto flex w-full flex-col gap-8 px-4 pb-10 pt-6 sm:px-6 lg:px-8 lg:pt-8 3xl:px-12", WIDTH[width], fullFrom3xl && "3xl:max-w-page", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export type PageHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  /** A short overline above the title — "Admin · People". */
  eyebrow?: ReactNode;
  /** The parent page, for a detail screen: "Members". */
  back?: { to: string; label: string };
  /** Right-aligned: icon buttons, a RefreshButton, one primary action. */
  actions?: ReactNode;
  /** A `<Freshness>`: beside the actions from `sm`, on its own line below the title on a phone. */
  freshness?: ReactNode;
  className?: string;
};

function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      data-page-back=""
      className="no-lift -ml-1 inline-flex min-h-touch items-center gap-1 self-start px-1 text-sm font-semibold text-accent-strong underline-offset-2 hover:underline"
    >
      <CaretLeft size={16} weight="bold" aria-hidden="true" />
      <span>{label}</span>
    </Link>
  );
}

/**
 * The page's header and its ONLY `<h1>`.
 *
 * <p>
 * <b>A word is never broken to keep the actions beside it</b> (review round 1, F1.16). On a phone
 * the row wraps: the title's basis is its LONGEST WORD, so the actions sit beside it while that
 * fits and drop under it when it does not — at twice the text size "Bookings" was broken
 * "Booki / ngs" to hold a refresh button in place. `break-words` stays as the last resort for a
 * single word wider than the screen.
 * </p>
 *
 * <p>
 * The `h1` carries `data-route-heading` from the start: `RouteAnnouncer` finds
 * `#main-content h1` on every navigation and moves focus to it (`lib/routeAnnouncer.ts`
 * `focusHeading` adds `tabindex="-1"` and the same attribute), and `index.css` hangs the
 * heading's scroll margin and its keyboard-only focus ring on the attribute.
 * </p>
 *
 * <p>
 * <b>The title row keeps its icon actions while the title's longest word fits beside them.</b>
 * The title wraps between words to make room (a refresh button stays beside it on a 360px phone);
 * a wider action cluster wraps inside its own box. No rem floor on the title: at a 32px root font
 * a 12rem floor alone is wider than a 320px screen, and the header pushed the page sideways
 * (e2e/admin-devices, admin-doors, large-text).
 * </p>
 *
 * <p>
 * <b>The same wrapping row at every width</b> (R6 L6-1 / X6-5). From `sm` it used to be a
 * `[1fr auto auto]` grid, whose title column shrank to whatever the actions left: at 200 % text
 * "Repeating bookings" painted "Repe / ating / booki / ngs" at 768 beside its create button, and
 * "Transactio / ns" at 1280 beside the admin rail. A flex row decides by the title's longest word
 * instead, so the actions drop under the title when that word does not fit beside them. From
 * `sm` the freshness line stands between the title and the actions.
 * </p>
 */
export function PageHeader(props: PageHeaderProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { title, description, eyebrow, back, actions, freshness, className } = props;
  return (
    <header data-page-header="" className={cn("-mb-2 flex flex-col gap-2", className)}>
      {back ? <BackLink to={back.to} label={back.label} /> : null}
      {eyebrow ? <p className={typography({ variant: "overline" })}>{eyebrow}</p> : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h1 data-route-heading="" className={cn(typography({ variant: "h1" }), "min-w-0 flex-[1_1_min-content] break-words")}>
          {title}
        </h1>
        {freshness ? (
          <div className="order-last basis-full sm:order-none sm:basis-auto">{freshness}</div>
        ) : null}
        {actions ? (
          <div data-page-actions="" className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {actions}
          </div>
        ) : null}
      </div>
      {description ? <p className="max-w-prose text-sm text-text-secondary">{description}</p> : null}
    </header>
  );
}

export type SectionProps = Omit<ComponentProps<"section">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
};

/** A titled region: `section[aria-labelledby]` with its `h2`, a description and right-aligned actions. */
export function Section({ title, description, actions, className, children, ...rest }: SectionProps) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("flex flex-col gap-4", className)} {...rest}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-[1_1_12rem]">
          <h2 id={id} className={cn(typography({ variant: "h2" }), "break-words")}>{title}</h2>
          {description ? <p className="mt-1 max-w-prose text-sm text-text-secondary">{description}</p> : null}
        </div>
        {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
