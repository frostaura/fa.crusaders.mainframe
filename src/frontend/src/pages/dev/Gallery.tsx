import { useEffect, useId, useLayoutEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Desktop, Moon, Sun, type Icon } from "@/components/ui/icons";
import { PageHeader, PageShell, Section } from "@/components/ui/page-shell";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { applyTheme, useTheme } from "@/lib/theme";
import type { ThemeName } from "@/lib/tokens";
import { SECTIONS, findSection, type GalleryEntry } from "./registry";

/**
 * The design-system gallery at `/dev/primitives` — development only (see `pages/DevPrimitives.tsx`
 * for why it is not in the production bundle).
 *
 * <p>
 * <b>Deep links.</b> `?section=<id>` shows one section (no parameter shows all of them);
 * `?theme=light|dark` paints the PAGE in that theme for as long as the gallery is open, without
 * touching the member's stored choice — the account menu owns that. The page theme matters for
 * everything that portals (dialogs, sheets, popovers, menus, toasts, the select list); static
 * specimens are shown in both themes at once regardless.
 * </p>
 */
type PageTheme = ThemeName | "system";

function parseTheme(raw: string | null): ThemeName | null {
  return raw === "light" || raw === "dark" ? raw : null;
}

function query(section: string | null, theme: ThemeName | null): string {
  const params = new URLSearchParams();
  if (section) params.set("section", section);
  if (theme) params.set("theme", theme);
  const text = params.toString();
  return text ? `?${text}` : "";
}

function withTheme(previous: URLSearchParams, theme: PageTheme): URLSearchParams {
  const next = new URLSearchParams(previous);
  if (theme === "system") next.delete("theme");
  else next.set("theme", theme);
  return next;
}

/**
 * Paints the page in `theme` while mounted and puts the member's own choice back afterwards,
 * without writing it to storage.
 *
 * <p>
 * <b>A leaf rendered FIRST, not a hook in the gallery.</b> Layout effects run in post-order, so a
 * hook in `Gallery` fires after every section's own layout effects — and several of those
 * (Radix, cmdk, the segmented tabs' measuring) read layout, which makes the engine compute styles
 * while the page is still light. Every `transition-colors` element then faded light → dark over
 * its first 250ms, and axe measured the halfway colours (the fields and legacy sections, only on a
 * warm load). As the gallery's first child this effect runs before any of theirs.
 * </p>
 */
function PageTheme({ theme }: { theme: ThemeName | null }) {
  const { theme: choice, resolved } = useTheme();
  useLayoutEffect(() => {
    if (!theme) return undefined;
    applyTheme(theme, theme);
    return () => applyTheme(choice, resolved);
  }, [theme, choice, resolved]);
  return null;
}

const THEME_OPTIONS: ReadonlyArray<[PageTheme, string, Icon]> = [
  ["system", "System", Desktop],
  ["light", "Light", Sun],
  ["dark", "Dark", Moon],
];

function ThemeSwitch({ value, onChange }: { value: PageTheme; onChange: (theme: PageTheme) => void }) {
  const labelId = useId();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span id={labelId} className="text-sm font-medium text-text-primary">Page theme</span>
      <ToggleGroup
        type="single"
        variant="outline"
        value={value}
        onValueChange={(next) => { if (next) onChange(next as PageTheme); }}
        aria-labelledby={labelId}
      >
        {THEME_OPTIONS.map(([option, label, Glyph]) => (
          <ToggleGroupItem key={option} value={option}>
            <Glyph aria-hidden="true" weight={value === option ? "fill" : "regular"} />
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

const INDEX_LINK = [
  "no-lift flex min-h-touch items-center rounded-lg border border-transparent px-3 text-sm font-medium text-text-secondary",
  "transition-colors duration-fast ease-standard motion-reduce:transition-none hover:bg-bg-muted hover:text-text-primary",
  "aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-strong",
].join(" ");

type IndexProps = { current: string | null; theme: ThemeName | null };

function IndexLink({ id, title, current, theme }: IndexProps & { id: string | null; title: string }) {
  return (
    <li>
      <Link to={{ search: query(id, theme) }} aria-current={current === id ? "page" : undefined} className={INDEX_LINK}>
        {title}
      </Link>
    </li>
  );
}

function GalleryIndex({ current, theme }: IndexProps) {
  return (
    <nav aria-label="Gallery sections" className="min-w-0 lg:sticky lg:top-0 lg:self-start">
      <ul className="flex flex-wrap gap-1 lg:flex-col lg:flex-nowrap">
        <IndexLink id={null} title="All sections" current={current} theme={theme} />
        {SECTIONS.map((entry) => (
          <IndexLink key={entry.id} id={entry.id} title={entry.title} current={current} theme={theme} />
        ))}
      </ul>
    </nav>
  );
}

function GallerySection({ entry }: { entry: GalleryEntry }) {
  const Body = entry.Body;
  return (
    <Section title={entry.title} description={entry.description} data-gallery-section={entry.id} className="min-w-0">
      <Body />
    </Section>
  );
}

/** A new section starts at the top: the app scrolls its `<main>`, not the document. */
function useScrollTopOn(key: string) {
  useEffect(() => {
    const main = document.getElementById("main-content");
    if (main && typeof main.scrollTo === "function") main.scrollTo({ top: 0 });
  }, [key]);
}

export default function Gallery() {
  const [params, setParams] = useSearchParams();
  const current = findSection(params.get("section"));
  const theme = parseTheme(params.get("theme"));
  useScrollTopOn(current?.id ?? "all");
  const setPageTheme = (next: PageTheme) => setParams((previous) => withTheme(previous, next), { replace: true });
  const visible = current ? [current] : SECTIONS;
  return (
    // `full`: two theme panels side by side beside an index need at least the admin width (in the
    // member frame the pass card overflowed its panel at 1280px — axe: scrollable-region-focusable),
    // and the layout section's split view needs a 64rem box beside the index to split at all.
    <PageShell width="full" data-gallery="" className="gap-6">
      <PageTheme theme={theme} />
      <PageHeader
        title="Primitives"
        description="Development only. Every design-system primitive, in both themes, with deep links for review and for the axe suite."
      />
      <ThemeSwitch value={theme ?? "system"} onChange={setPageTheme} />
      <div className="grid min-w-0 gap-8 lg:grid-cols-[11rem_minmax(0,1fr)]">
        <GalleryIndex current={current?.id ?? null} theme={theme} />
        <div className="flex min-w-0 flex-col gap-16">
          {visible.map((entry) => <GallerySection key={entry.id} entry={entry} />)}
        </div>
      </div>
    </PageShell>
  );
}
