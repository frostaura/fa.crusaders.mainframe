import { contrastRatio, composite, cssVariables, roles, themes, type RoleName, type ThemeName } from "./tokens";

/**
 * Per-member theme overrides.
 *
 * <p>
 * A member may repaint the roles in {@link OVERRIDABLE} for each theme. Nothing here widens the
 * token layer: an override is a hex written over a role's value before the same
 * {@link cssVariables} emission the stylesheet uses, so a slot state that is derived from a role
 * follows it, and no component learns that overrides exist.
 * </p>
 *
 * <p>
 * <b>An override that cannot be read is not applied.</b> {@link resolveOverrides} measures every
 * foreground/background pair the overridable roles take part in — against the SAME floors the
 * shipped palette is held to (`tokens.themes.test.ts`) — and drops any override that breaks one,
 * naming the pair. Pairs that already fail in the shipped theme are not the member's doing and
 * are ignored. Not overridable, on purpose: the crest (`brand-*`), status colours and the scrim —
 * their meaning is the point, and the crest is a full-bleed fill that cannot be re-inked.
 * </p>
 */

export const OVERRIDABLE = [
  "bg-app", "bg-surface", "bg-muted", "bg-raised",
  "text-primary", "text-secondary", "text-muted",
  "border", "control",
  "primary", "primary-ink", "primary-hover",
  "accent-strong", "accent-soft", "ring",
] as const;

export type OverridableRole = (typeof OVERRIDABLE)[number];
export type RoleOverrides = Partial<Record<OverridableRole, string>>;
export type ThemeOverrides = Partial<Record<ThemeName, RoleOverrides>>;

export const STORAGE_PREFIX = "crusaders:theme-overrides:";
/** The compiled stylesheet text `public/theme-boot.js` injects before first paint. */
export const CSS_CACHE_KEY = "crusaders:theme-css";
export const STYLE_ELEMENT_ID = "crusaders-user-theme";

const HEX = /^#[0-9A-Fa-f]{6}$/;

export interface Rejection { role: OverridableRole; theme: ThemeName; reason: string }

export interface Resolution {
  /** What actually paints: valid, readable overrides only. */
  applied: ThemeOverrides;
  rejected: Rejection[];
  /** The stylesheet text for `applied`; empty when nothing is. */
  css: string;
}

interface Pair { fg: RoleName; bg: RoleName; min: number }

const SURFACES = ["bg-app", "bg-surface", "bg-muted", "bg-raised"];

/** Every pair an overridable role is part of. Floors: 4.5 text, 3 non-text (WCAG 1.4.3 / 1.4.11). */
const PAIRS: Pair[] = [
  ...["text-primary", "text-secondary", "text-muted", "accent-strong",
    "success-strong", "info-strong", "warning-strong", "danger-strong"]
    .flatMap((fg) => SURFACES.map((bg) => ({ fg, bg, min: 4.5 }))),
  { fg: "accent-strong", bg: "accent-soft", min: 4.5 },
  { fg: "text-primary", bg: "accent-soft", min: 4.5 },
  { fg: "primary-ink", bg: "primary", min: 4.5 },
  { fg: "primary-ink", bg: "primary-hover", min: 4.5 },
  ...["control", "ring"].flatMap((fg) => ["bg-app", "bg-surface"].map((bg) => ({ fg, bg, min: 3 }))),
  { fg: "primary", bg: "bg-app", min: 3 },
  { fg: "primary", bg: "bg-surface", min: 3 },
];

export function isHex(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

function failing(r: Record<RoleName, string>): Pair[] {
  return PAIRS.filter((p) => r[p.fg] && r[p.bg] && contrastRatio(r[p.fg], r[p.bg]) < p.min);
}

function label(role: string): string {
  return role.replace(/-/g, " ");
}

/** Validate, drop what cannot be read, and compile. Pure. */
export function resolveOverrides(requested: ThemeOverrides): Resolution {
  const applied: ThemeOverrides = {};
  const rejected: Rejection[] = [];
  for (const theme of Object.keys(themes) as ThemeName[]) {
    const base = roles(theme);
    const already = new Set(failing(base).map((p) => `${p.fg}|${p.bg}`));
    const live: RoleOverrides = {};
    for (const role of OVERRIDABLE) {
      const value = requested[theme]?.[role];
      if (value === undefined) continue;
      if (!isHex(value)) rejected.push({ role, theme, reason: `${label(role)} must be a #RRGGBB colour` });
      else live[role] = value.toUpperCase();
    }
    // Greedy: drop the overridden role that sits in the most failing pairs (the foreground on a
    // tie — it is the text that is unreadable), then re-measure. Each round removes one role, so
    // it ends in at most |live| rounds, and a harmless override survives a refused neighbour.
    for (;;) {
      const r: Record<RoleName, string> = { ...base, ...(live as Record<string, string>) };
      const bad = failing(r).filter((p) => !already.has(`${p.fg}|${p.bg}`));
      if (bad.length === 0) break;
      const score = new Map<OverridableRole, { n: number; fg: number; why: string }>();
      for (const p of bad) {
        const why = `${label(p.fg)} on ${label(p.bg)} would be ${contrastRatio(r[p.fg], r[p.bg]).toFixed(1)}:1 — needs ${p.min}:1`;
        for (const role of [p.fg, p.bg]) {
          if (!(role in live)) continue;
          const key = role as OverridableRole;
          const entry = score.get(key) ?? { n: 0, fg: 0, why };
          entry.n += 1;
          if (role === p.fg) entry.fg += 1;
          score.set(key, entry);
        }
      }
      const worst = [...score.entries()].sort((x, y) => y[1].n - x[1].n || y[1].fg - x[1].fg)[0];
      if (!worst) break; // every failing pair is between shipped roles; nothing of the member's to blame
      rejected.push({ role: worst[0], theme, reason: worst[1].why });
      delete live[worst[0]];
    }
    if (Object.keys(live).length > 0) applied[theme] = live;
  }
  return { applied, rejected, css: compile(applied) };
}

function compile(applied: ThemeOverrides): string {
  const block = (selector: string, theme: ThemeName) => {
    const o = applied[theme];
    if (!o) return "";
    const vars = cssVariables(theme, o);
    const base = cssVariables(theme);
    const changed = Object.entries(vars).filter(([k, v]) => base[k] !== v).map(([k, v]) => `${k}:${v}`);
    return changed.length ? `${selector}{${changed.join(";")}}` : "";
  };
  // `html:not(.dark)` / `html.dark` out-rank the stylesheet's `:root, .light` / `.dark` on
  // specificity, so the order the two sheets load in does not matter. Print stays on the paper theme.
  const css = block("html:not(.dark)", "light") + block("html.dark", "dark");
  return css ? `@media not print{${css}}` : "";
}

// ---------------------------------------------------------------------------------------------
// Derivation — one colour in, a coherent set of roles out
// ---------------------------------------------------------------------------------------------

const mix = (a: string, b: string, t: number) => composite(b, a, t);

/** Black or white, whichever reads better on `bg`. */
export function inkFor(bg: string): string {
  return contrastRatio("#FFFFFF", bg) >= contrastRatio("#000000", bg) ? "#FFFFFF" : "#000000";
}

/**
 * A whole accent from one colour: the filled button, its hover and ink, the link/ring colour and
 * the soft tint. The result still goes through {@link resolveOverrides}, so a hue that cannot be
 * made readable on the member's backgrounds is refused, not bent.
 */
export function accentRoles(hex: string, theme: ThemeName): RoleOverrides {
  const base = isHex(hex) ? hex.toUpperCase() : "#000000";
  const surface = themes[theme].bg.app;
  const strong = theme === "light" ? base : mix(base, "#FFFFFF", 0.4);
  const hover = theme === "light" ? mix(base, "#000000", 0.2) : mix(base, "#000000", 0.12);
  return {
    primary: base,
    "primary-hover": hover,
    "primary-ink": inkFor(base),
    "accent-strong": strong,
    "accent-soft": mix(surface, base, theme === "light" ? 0.12 : 0.22),
    ring: strong,
  };
}

// ---------------------------------------------------------------------------------------------
// Persistence and application (browser)
// ---------------------------------------------------------------------------------------------

function storageKey(userId: string) { return `${STORAGE_PREFIX}${userId}`; }

export function loadOverrides(userId: string): ThemeOverrides {
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return {};
    const out: ThemeOverrides = {};
    for (const theme of Object.keys(themes) as ThemeName[]) {
      const source = (parsed as Record<string, unknown>)[theme];
      if (!source || typeof source !== "object") continue;
      const roleMap: RoleOverrides = {};
      for (const role of OVERRIDABLE) {
        const v = (source as Record<string, unknown>)[role];
        if (isHex(v)) roleMap[role] = v.toUpperCase();
      }
      if (Object.keys(roleMap).length) out[theme] = roleMap;
    }
    return out;
  } catch {
    return {};
  }
}

/** Paint `css` (empty clears) and keep the boot script's copy in step. */
export function applyCss(css: string): void {
  if (typeof document === "undefined") return;
  let el = document.getElementById(STYLE_ELEMENT_ID);
  if (!css) el?.remove();
  else {
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ELEMENT_ID;
      document.head.appendChild(el);
    }
    el.textContent = css;
  }
  try {
    if (css) window.localStorage.setItem(CSS_CACHE_KEY, css);
    else window.localStorage.removeItem(CSS_CACHE_KEY);
  } catch {
    // Storage refused: the overrides last for this page only.
  }
}

/** Persist the member's request and paint what survives validation. Returns the resolution. */
export function saveOverrides(userId: string, requested: ThemeOverrides): Resolution {
  const resolution = resolveOverrides(requested);
  try {
    // The REQUEST is kept, not the resolution: a background changed later may make a refused
    // override readable again, and the editor shows what the member asked for.
    if (Object.keys(requested).length === 0) window.localStorage.removeItem(storageKey(userId));
    else window.localStorage.setItem(storageKey(userId), JSON.stringify(requested));
  } catch {
    // Storage refused: see applyCss.
  }
  applyCss(resolution.css);
  return resolution;
}

/** Paint a member's stored overrides (sign-in, or a different member on the same device). */
export function applyStoredOverrides(userId: string): Resolution {
  const resolution = resolveOverrides(loadOverrides(userId));
  applyCss(resolution.css);
  return resolution;
}

