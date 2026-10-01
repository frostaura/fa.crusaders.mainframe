import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { SETTINGS_COPY } from "@/lib/settingsCopy";
import type { SettingsSectionDef, SettingsSectionId } from "@/lib/settingsSchema";

/**
 * The sections, listed BESIDE them (R4 form factor, SPEC §3.12): where the page has the room, a
 * sticky index with each section's name, its one-line summary and a dot where it holds unsaved
 * changes. A press opens that section and brings it into view; the entry for the section at the
 * top of the screen is marked as the current one as the page scrolls.
 *
 * <p>
 * <b>A nav of buttons, not links.</b> A section is not a page: pressing one opens an accordion
 * panel, which a link's URL could not express. The current entry carries `aria-current="true"`
 * (with a leading bar, never colour alone).
 * </p>
 */
export type SettingsIndexProps = {
  sections: readonly SettingsSectionDef[];
  summaryOf: (id: SettingsSectionId) => string;
  dirty: ReadonlySet<SettingsSectionId>;
  onGo: (id: SettingsSectionId) => void;
};

export function SettingsIndex({ sections, summaryOf, dirty, onGo }: SettingsIndexProps) {
  const current = useCurrentSection(sections);
  return (
    <nav aria-label={SETTINGS_COPY.indexLabel} className="flex flex-col gap-1">
      <ul className="flex flex-col gap-0.5">
        {sections.map((section) => (
          <li key={section.id}>
            <button
              type="button"
              data-settings-index={section.id}
              aria-current={current === section.id ? "true" : undefined}
              onClick={() => onGo(section.id)}
              className={cn(
                "no-lift relative flex w-full min-h-touch flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left",
                "transition-colors duration-fast ease-standard hover:bg-bg-muted motion-reduce:transition-none",
                "before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-full",
                "aria-[current=true]:bg-accent-soft aria-[current=true]:before:bg-accent-strong",
              )}
            >
              <span className="flex w-full items-center gap-2 text-sm font-semibold text-text-primary">
                <span className="min-w-0 flex-1 break-words">{section.title}</span>
                {dirty.has(section.id) ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-accent-strong">
                    <span aria-hidden="true" className="size-2 rounded-full bg-accent-strong" />
                    <span className="sr-only">{SETTINGS_COPY.unsaved}</span>
                  </span>
                ) : null}
              </span>
              <span className="line-clamp-2 text-xs text-text-secondary">{summaryOf(section.id)}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The section whose top is nearest under the top of the scroller — a scroll-spy by IntersectionObserver. */
function useCurrentSection(sections: readonly SettingsSectionDef[]): SettingsSectionId | null {
  const [current, setCurrent] = useState<SettingsSectionId | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return undefined;
    const seen = new Map<string, number>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = entry.target.id.replace(/^settings-/, "");
        if (entry.isIntersecting) seen.set(id, entry.boundingClientRect.top); else seen.delete(id);
      }
      const first = [...seen.entries()].sort((a, b) => a[1] - b[1])[0];
      if (first) setCurrent(first[0] as SettingsSectionId);
    }, { rootMargin: "0px 0px -60% 0px" });
    for (const section of sections) {
      const el = document.getElementById(`settings-${section.id}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [sections]);
  return current;
}
