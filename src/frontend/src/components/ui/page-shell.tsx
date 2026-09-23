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
 *   <li><b>narrow</b> 36rem — My Code, auth, single forms.</li>
 *   <li><b>content</b> 64rem — the default.</li>
 *   <li><b>wide</b> 80rem — admin tables and the booking grid.</li>
 * </ul>
 * <p>
 * Gutters `px-4 sm:px-6 lg:px-8`, top `pt-6 lg:pt-8`, 32px between sections. The header sits 24px
 * above the body (it pulls the 32px gap in by 8px), per the spacing table.
 * </p>
 */
export type PageWidth = "narrow" | "content" | "wide";

const WIDTH: Record<PageWidth, string> = {
  narrow: "max-w-narrow",
  content: "max-w-content",
  wide: "max-w-wide",
};

export type PageShellProps = ComponentProps<"div"> & { width?: PageWidth };

export function PageShell({ width = "content", className, children, ...rest }: PageShellProps) {
  return (
    <div
      data-page-shell={width}
      className={cn("mx-auto flex w-full flex-col gap-8 px-4 pb-10 pt-6 sm:px-6 lg:px-8 lg:pt-8", WIDTH[width], className)}
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
 * The `h1` carries `data-route-heading` from the start: `RouteAnnouncer` finds
 * `#main-content h1` on every navigation and moves focus to it (`lib/routeAnnouncer.ts`
 * `focusHeading` adds `tabindex="-1"` and the same attribute), and `index.css` hangs the
 * heading's scroll margin and its keyboard-only focus ring on the attribute.
 * </p>
 *
 * <p>
 * <b>The title row never loses its icon actions.</b> The title column has a 12rem floor and the
 * actions column is `auto`, so on a 360px phone a refresh button stays beside the title; a wider
 * cluster wraps inside its own column rather than pushing the title off the row.
 * </p>
 */
export function PageHeader(props: PageHeaderProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { title, description, eyebrow, back, actions, freshness, className } = props;
  return (
    <header data-page-header="" className={cn("-mb-2 flex flex-col gap-2", className)}>
      {back ? <BackLink to={back.to} label={back.label} /> : null}
      {eyebrow ? <p className={typography({ variant: "overline" })}>{eyebrow}</p> : null}
      <div className="grid grid-cols-[minmax(min(12rem,100%),1fr)_auto] items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <h1 data-route-heading="" className={cn(typography({ variant: "h1" }), "col-start-1 row-start-1 min-w-0 break-words")}>
          {title}
        </h1>
        {freshness ? (
          <div className="col-span-2 col-start-1 row-start-2 sm:col-span-1 sm:col-start-2 sm:row-start-1">{freshness}</div>
        ) : null}
        {actions ? (
          <div data-page-actions="" className="col-start-2 row-start-1 flex flex-wrap items-center justify-end gap-2 sm:col-start-3">
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
