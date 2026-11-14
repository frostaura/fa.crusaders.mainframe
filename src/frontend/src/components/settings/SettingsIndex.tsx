import { useEffect, useState } from "react";
import { sectionAtTop } from "@/lib/settingsSpy";
import { cn } from "@/lib/utils";
import { SETTINGS_COPY } from "@/lib/settingsCopy";
import type { SettingsSectionDef, SettingsSectionId } from "@/lib/settingsSchema";

/**
 * The sections, listed BESIDE them (R4 form factor, SPEC §3.12): where the page has the room, a
 * sticky index with each section's name and a dot where it holds unsaved changes. Not its
 * summary: the accordion beside it already says that line, and the same words twice in one view
 * are two answers to "where is it?". A press opens that section and brings it into view; the entry for the section at the
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
  dirty: ReadonlySet<SettingsSectionId>;
  onGo: (id: SettingsSectionId) => void;
};

export function SettingsIndex({ sections, dirty, onGo }: SettingsIndexProps) {
  const current = useCurrentSection(sections);
  return (
    <nav aria-label={SETTINGS_COPY.indexLabel} className="flex flex-col gap-1">
      <ul className="flex flex-col gap-0.5">
        {sections.map((section) => (
          <li key={section.id}>
            <button
              type="button"
              data-settings-index={section.id}
              // "Go to Bookings", not "Bookings": the section's own header is the button named
              // that, and two controls with one name are two guesses (the visible words lead).
              aria-label={SETTINGS_COPY.indexGo(section.title, dirty.has(section.id))}
              aria-current={current === section.id ? "true" : undefined}
              onClick={() => onGo(section.id)}
              className={cn(
                "no-lift relative flex w-full min-h-touch items-center rounded-lg px-3 py-2 text-left",
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
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The section the admin is reading — see `lib/settingsSpy` (BA-18). */
function useCurrentSection(sections: readonly SettingsSectionDef[]): SettingsSectionId | null {
  const [current, setCurrent] = useState<SettingsSectionId | null>(null);
  useEffect(() => {
    const scroller = document.getElementById("main-content");
    const target: HTMLElement | Window = scroller ?? window;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const scrollerTop = scroller ? scroller.getBoundingClientRect().top : 0;
      const tops = sections.flatMap((section) => {
        const el = document.getElementById(`settings-${section.id}`);
        return el ? [{ id: section.id, top: el.getBoundingClientRect().top }] : [];
      });
      const id = sectionAtTop(tops, scrollerTop);
      if (id) setCurrent(id as SettingsSectionId);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [sections]);
  return current;
}
