/* eslint-disable react-refresh/only-export-components -- the gallery's shared parts and the two helpers they need live together; this chunk is dev-only. */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { typography } from "@/lib/typography";
import type { ThemeName } from "@/lib/tokens";
import { clubZone } from "@/lib/clubZone";

/**
 * The building blocks every gallery section shares.
 *
 * <p>
 * <b>Both themes at once.</b> The token layer is CSS variables scoped to `:root, .light` and
 * `.dark`, so a `.dark` div inside a light page repaints everything under it — no provider, no
 * re-render. {@link ThemePair} uses that to show static content light and dark side by side.
 * Anything that PORTALS (dialogs, popovers, menus, the select list) renders into `<body>` and
 * follows the page's own theme instead; the gallery's theme switch drives that.
 * </p>
 *
 * <p>
 * Each panel scrolls sideways on its own, so a wide specimen (the slot grid, a table, a 32px root
 * font) never widens the page.
 * </p>
 */
export const THEMES: readonly ThemeName[] = ["light", "dark"];

const THEME_LABEL: Record<ThemeName, string> = { light: "Light", dark: "Dark" };

type ThemePairProps = {
  children: (theme: ThemeName) => ReactNode;
  className?: string;
};

export function ThemePair({ children, className }: ThemePairProps) {
  return (
    <div className="grid min-w-0 gap-3 md:grid-cols-2">
      {THEMES.map((theme) => (
        <div
          key={theme}
          data-theme-panel={theme}
          className={cn(
            theme,
            "min-w-0 overflow-x-auto rounded-xl border border-border bg-bg-app p-4 text-text-primary",
            className,
          )}
        >
          <p className={cn(typography({ variant: "overline" }), "mb-3")}>{THEME_LABEL[theme]}</p>
          {children(theme)}
        </div>
      ))}
    </div>
  );
}

type DemoProps = {
  title: ReactNode;
  note?: ReactNode;
  children: ReactNode;
  className?: string;
};

/** One specimen group: an h3, an optional line of context, then the specimens. */
export function Demo({ title, note, children, className }: DemoProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex flex-col gap-1">
        <h3 className={typography({ variant: "h3" })}>{title}</h3>
        {note ? <p className="max-w-prose text-sm text-text-secondary">{note}</p> : null}
      </div>
      {children}
    </div>
  );
}

type SpecimenProps = {
  label: ReactNode;
  children: ReactNode;
  className?: string;
};

/** A specimen with its caption underneath. */
export function Specimen({ label, children, className }: SpecimenProps) {
  return (
    <figure className={cn("flex min-w-0 flex-col items-start gap-1.5", className)}>
      {children}
      <figcaption className="text-xs text-text-muted">{label}</figcaption>
    </figure>
  );
}

/** A role's live colour, for a swatch that must follow whichever theme wraps it. */
export function roleColour(role: string, alpha?: string): string {
  return alpha ? `rgb(var(--color-${role}) / ${alpha})` : `rgb(var(--color-${role}))`;
}

/** The club's today as `YYYY-MM-DD`, in the club's zone when it is known, else the device's. */
export function clubToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: clubZone(), year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/** `YYYY-MM-DD` plus `days`, by calendar arithmetic at UTC midnight (no zone can move it). */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}
