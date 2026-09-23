import { typography, type TypographyVariant } from "@/lib/typography";
import { layout, radius, z } from "@/lib/tokens";
import { Specimen } from "./parts";

/**
 * The named scales (design-system.md, Scales): type recipes, radius, elevation, spacing and the
 * z-index ladder. Every class below is written out in full — Tailwind finds classes by scanning
 * source text, so a class assembled from a variable would never be generated.
 */

const TYPE_SAMPLES: ReadonlyArray<[TypographyVariant, string]> = [
  ["display", "1 250 cr"],
  ["h1", "Book a court"],
  ["h2", "Section title"],
  ["h3", "Card title"],
  ["body", "Body copy reads at 16px on every phone."],
  ["ui", "Control label, 14px medium"],
  ["label", "Field label"],
  ["caption", "Caption: updated 12s ago"],
  ["overline", "Admin · People"],
  ["numeric", "18:00 – 19:30 · 137.50"],
];

export function TypeRecipes() {
  return (
    <ul className="grid gap-3">
      {TYPE_SAMPLES.map(([variant, sample]) => (
        <li key={variant} className="flex min-w-0 flex-col gap-0.5">
          <span className="font-mono text-xs text-text-muted">{variant}</span>
          <span className={`${typography({ variant })} break-words`}>{sample}</span>
        </li>
      ))}
    </ul>
  );
}

const RADII: ReadonlyArray<[keyof typeof radius, string]> = [
  ["sm", "rounded-sm"],
  ["md", "rounded-md"],
  ["lg", "rounded-lg"],
  ["xl", "rounded-xl"],
  ["2xl", "rounded-2xl"],
  ["full", "rounded-full"],
];

export function RadiusScale() {
  return (
    <div className="flex flex-wrap gap-4">
      {RADII.map(([key, cls]) => (
        <Specimen key={key} label={`${key} · ${radius[key]}`}>
          <div className={`size-14 border-2 border-control bg-bg-surface ${cls}`} />
        </Specimen>
      ))}
    </div>
  );
}

const ELEVATION: ReadonlyArray<[string, string, string]> = [
  ["0", "canvas, cells", "bg-bg-app"],
  ["1 · xs", "card: border + xs", "border border-border bg-bg-surface shadow-xs"],
  ["2 · md", "hover, sticky bars", "bg-bg-surface shadow-md"],
  ["3 · md", "popover: raised + border", "border border-border bg-bg-raised shadow-md"],
  ["4 · lg", "dialog, sheet, toast", "bg-bg-raised shadow-lg"],
];

export function ElevationScale() {
  return (
    <div className="flex flex-wrap gap-4">
      {ELEVATION.map(([level, use, cls]) => (
        <Specimen key={level} label={`${level} — ${use}`}>
          <div className={`h-16 w-28 rounded-xl ${cls}`} />
        </Specimen>
      ))}
    </div>
  );
}

const SPACING: ReadonlyArray<[string, string]> = [
  ["0.5 · 2px", "w-0.5"],
  ["1 · 4px", "w-1"],
  ["1.5 · 6px", "w-1.5"],
  ["2 · 8px", "w-2"],
  ["3 · 12px", "w-3"],
  ["4 · 16px", "w-4"],
  ["5 · 20px", "w-5"],
  ["6 · 24px", "w-6"],
  ["8 · 32px", "w-8"],
  ["10 · 40px", "w-10"],
  ["12 · 48px", "w-12"],
  ["16 · 64px", "w-16"],
  [`touch · ${layout.touch}`, "w-touch"],
  [`appbar · ${layout.appbar}`, "w-appbar"],
  [`tabbar · ${layout.tabbar}`, "w-tabbar"],
];

export function SpacingScale() {
  return (
    <ul className="grid gap-1.5">
      {SPACING.map(([label, cls]) => (
        <li key={label} className="flex items-center gap-3">
          <span className="w-24 shrink-0 font-mono text-xs text-text-secondary">{label}</span>
          <span aria-hidden="true" className={`h-3 rounded-sm bg-accent-strong ${cls}`} />
        </li>
      ))}
    </ul>
  );
}

export function ZScale() {
  const entries = Object.entries(z).sort((a, b) => Number(a[1]) - Number(b[1]));
  return (
    <ol className="grid gap-1 sm:grid-cols-2">
      {entries.map(([name, value]) => (
        <li key={name} className="flex items-center justify-between gap-3 rounded-md bg-bg-muted px-3 py-1.5 text-sm">
          <span className="font-mono text-text-primary">{`z-${name}`}</span>
          <span className="tabular-nums text-text-secondary">{value}</span>
        </li>
      ))}
    </ol>
  );
}
