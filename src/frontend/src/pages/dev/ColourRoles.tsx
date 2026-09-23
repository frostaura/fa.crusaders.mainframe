import { Badge } from "@/components/ui/badge";
import { contrastRatio, roles, type ThemeName } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import { roleColour } from "./parts";

/**
 * Every semantic colour role as a swatch, and the pairings the product actually paints, each with
 * its contrast ratio computed from `lib/tokens.ts` for the theme it sits in. The swatch paints the
 * LIVE variable (so it proves the CSS emission), and the number comes from the token module (so it
 * proves the value); a disagreement between the two is visible on this page.
 */

/** Text pairs clear 4.5:1; UI edges clear 3:1; decorative hairlines are allowed to be quiet. */
type PairKind = "text" | "ui" | "decorative";
/** Roles in the spec's dot notation (`text.muted`), which is also what the rows print. */
type Pair = { ink: string; fill: string; kind: PairKind };

const text = (ink: string, fill: string): Pair => ({ ink, fill, kind: "text" });
const ui = (ink: string, fill: string): Pair => ({ ink, fill, kind: "ui" });

const SURFACES = ["bg.app", "bg.surface", "bg.muted", "bg.raised"];

const PAIRS: readonly Pair[] = [
  ...["text.primary", "text.secondary", "text.muted"].flatMap((ink) => SURFACES.map((fill) => text(ink, fill))),
  text("primary.ink", "primary"),
  text("primary.ink", "primary.hover"),
  text("accent.strong", "bg.surface"),
  text("accent.strong", "accent.soft"),
  text("brand.ink", "brand.strong"),
  text("brand.tin", "bg.app"),
  text("success.strong", "success.soft"),
  text("info.strong", "info.soft"),
  text("warning.strong", "warning.soft"),
  text("danger.strong", "danger.soft"),
  text("danger.ink", "danger.solid"),
  text("armed.ink", "armed.strong"),
  ui("control", "bg.surface"),
  ui("control", "bg.app"),
  ui("control", "bg.muted"),
  ui("ring", "bg.app"),
  ui("ring", "bg.surface"),
  { ink: "border", fill: "bg.surface", kind: "decorative" },
];

/** `text.muted` → `text-muted`, the name `roles()` and the CSS variables use. */
const variable = (role: string) => role.replace(".", "-");

const FLOOR: Record<PairKind, number> = { text: 4.5, ui: 3, decorative: 0 };

/** The ratio of a pair in a theme, from the token values (not the painted pixels). */
function pairRatio(pair: Pair, theme: ThemeName): number {
  const values = roles(theme);
  return contrastRatio(values[variable(pair.ink)], values[variable(pair.fill)]);
}

function Verdict({ pair, theme }: { pair: Pair; theme: ThemeName }) {
  const ratio = pairRatio(pair, theme);
  const shown = `${ratio.toFixed(2)}:1`;
  if (pair.kind === "decorative") return <Badge tone="neutral">{`${shown} decorative`}</Badge>;
  const passes = ratio >= FLOOR[pair.kind];
  const floor = pair.kind === "text" ? "AA text" : "AA non-text";
  return (
    <Badge tone={passes ? "success" : "danger"} data-contrast={passes ? "pass" : "fail"}>
      {passes ? `${shown} ${floor}` : `${shown} below ${floor}`}
    </Badge>
  );
}

function PairSample({ pair }: { pair: Pair }) {
  if (pair.kind === "text") {
    return <span aria-hidden="true" className="w-8 shrink-0 text-lg font-semibold" style={{ color: roleColour(variable(pair.ink)) }}>Aa</span>;
  }
  return <span aria-hidden="true" className="size-6 shrink-0 rounded-md border-2" style={{ borderColor: roleColour(variable(pair.ink)) }} />;
}

function PairRow({ pair, theme }: { pair: Pair; theme: ThemeName }) {
  const label = `${pair.ink} on ${pair.fill}`;
  const inkClass = pair.kind === "text" ? undefined : "text-text-primary";
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border px-3 py-2"
      style={{ backgroundColor: roleColour(variable(pair.fill)) }}
    >
      <PairSample pair={pair} />
      <span className={cn("min-w-0 flex-1 break-words text-xs font-medium", inkClass)} style={pair.kind === "text" ? { color: roleColour(variable(pair.ink)) } : undefined}>
        {label}
      </span>
      <Verdict pair={pair} theme={theme} />
    </li>
  );
}

export function ContrastPairs({ theme }: { theme: ThemeName }) {
  return (
    <ul className="grid gap-2" aria-label={`Contrast pairs, ${theme} theme`}>
      {PAIRS.map((pair) => <PairRow key={`${pair.ink}/${pair.fill}`} pair={pair} theme={theme} />)}
    </ul>
  );
}

function Swatch({ name, hex }: { name: string; hex: string }) {
  const alpha = name === "overlay" ? "var(--alpha-overlay)" : undefined;
  return (
    <li className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        className="size-8 shrink-0 rounded-md border border-border"
        style={{ backgroundColor: roleColour(name, alpha) }}
      />
      <span className="flex min-w-0 flex-col">
        <span className="break-words text-xs font-semibold text-text-primary">{name}</span>
        <span className="font-mono text-xs text-text-secondary">{hex}</span>
      </span>
    </li>
  );
}

export function Swatches({ theme }: { theme: ThemeName }) {
  const values = Object.entries(roles(theme));
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label={`Colour roles, ${theme} theme`}>
      {values.map(([name, hex]) => <Swatch key={name} name={name} hex={hex} />)}
    </ul>
  );
}
