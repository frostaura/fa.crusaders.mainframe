import { useId, type ReactNode } from "react";
import { Accordion as AccordionPrimitive } from "radix-ui";
import { AccordionItem } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { CaretDown } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { SETTINGS_COPY } from "@/lib/settingsCopy";
import { isServed, resolve, settingsIn, type SettingsSectionDef } from "@/lib/settingsSchema";
import { useSettingsForm } from "./form";
import { SettingField } from "./SettingField";

/**
 * One Settings section: a header that says what the section is set to, and a body of fields.
 *
 * <p>
 * <b>The header is the overview.</b> Title, a live one-line summary of the working copy, and a dot
 * when something in it is unsaved — so ten collapsed rows read as the club's whole configuration
 * and an admin opens only the one that is wrong. The heading's accessible name is the title alone
 * (`aria-labelledby`); the summary and the unsaved state are its description, so a screen reader
 * lists "Door gates" and then hears the detail, rather than a heading made of a paragraph.
 * </p>
 *
 * <p>
 * <b>Why the body is ours and not `AccordionContent`.</b> Radix unmounts a closed section's
 * children even under `forceMount` — it keeps the wrapper and drops what is inside it. This page
 * needs every field mounted all the time: the save bar's error summary links to fields in closed
 * sections, a deep link (`#setting-gate-unlock-seconds`) has to find its target before it opens
 * it, and a field's "you left this wrong" state must survive its section closing. So Radix owns
 * the header, the trigger and the arrow-key model; the panel is a plain region that is `hidden`
 * while closed.
 * </p>
 */
export type SettingsSectionProps = {
  section: SettingsSectionDef;
  open: boolean;
  summary: string;
  dirty: boolean;
  hidden: boolean;
  badge?: ReactNode;
  /** Content above the fields — a notice the whole section is read under. */
  before?: ReactNode;
  /** Content below the fields — a derived sentence, a weekly table. */
  after?: ReactNode;
  advancedOpen: boolean;
  onAdvancedChange: (open: boolean) => void;
};

function SectionHeader(props: Pick<SettingsSectionProps, "section" | "summary" | "dirty" | "badge"> & { panelId: string }) {
  const { section, summary, dirty, badge, panelId } = props;
  const titleId = `settings-${section.id}-title`;
  const summaryId = `settings-${section.id}-summary`;
  const dirtyId = `settings-${section.id}-dirty`;
  return (
    <AccordionPrimitive.Header asChild>
      <h2 className="flex">
        <AccordionPrimitive.Trigger
          aria-labelledby={titleId}
          aria-describedby={dirty ? `${summaryId} ${dirtyId}` : summaryId}
          aria-controls={panelId}
          className={cn(
            "no-lift group/section flex min-h-touch flex-1 items-center gap-3 rounded-lg border border-transparent py-4 text-left",
            "transition-colors duration-fast ease-standard motion-reduce:transition-none",
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span id={titleId} className="text-base font-semibold text-text-primary group-hover/section:text-accent-strong">
                {section.title}
              </span>
              {badge}
              {dirty ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent-strong">
                  <span aria-hidden="true" className="size-2 rounded-full bg-accent-strong" />
                  <span id={dirtyId}>{SETTINGS_COPY.unsaved}</span>
                </span>
              ) : null}
            </span>
            <span id={summaryId} className="mt-0.5 line-clamp-2 block text-sm text-text-secondary">{summary}</span>
          </span>
          <CaretDown
            size={20}
            aria-hidden="true"
            className={cn(
              "shrink-0 text-text-secondary transition-transform duration-base ease-standard",
              "group-data-[state=open]/section:rotate-180 motion-reduce:transition-none",
            )}
          />
        </AccordionPrimitive.Trigger>
      </h2>
    </AccordionPrimitive.Header>
  );
}

/** The fields a section shows, split into the everyday and the advanced. */
function useSectionFields(section: SettingsSectionDef) {
  const { settings, visible } = useSettingsForm();
  const served = settingsIn(section.id).filter((def) => isServed(def, settings));
  return {
    served,
    main: served.filter((def) => !def.advanced),
    advanced: served.filter((def) => def.advanced),
    advancedMatches: served.some((def) => def.advanced && visible(def.key)),
  };
}

function AdvancedFields(props: { id: string; count: number; open: boolean; onChange: (open: boolean) => void; children: ReactNode }) {
  const { id, count, open, onChange, children } = props;
  return (
    <div className="flex flex-col gap-4 border-t border-border pt-4">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 self-start text-text-secondary"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => onChange(!open)}
        icon={<CaretDown aria-hidden="true" className={cn("transition-transform duration-base motion-reduce:transition-none", open && "rotate-180")} />}
      >
        {open ? SETTINGS_COPY.advancedHide : SETTINGS_COPY.advancedShow(count)}
      </Button>
      <div id={id} hidden={!open} className="grid gap-x-6 gap-y-6 sm:grid-cols-2 [&[hidden]]:hidden">{children}</div>
    </div>
  );
}

export function SettingsSection(props: SettingsSectionProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { section, open, hidden, before, after, advancedOpen, onAdvancedChange } = props;
  const { context, query } = useSettingsForm();
  const panelId = useId();
  const advancedId = useId();
  const fields = useSectionFields(section);
  const lede = resolve(section.lede, context);
  // A search that matches an advanced setting opens the disclosure for it: a match hidden behind
  // "Show 3 advanced settings" is a match the admin was not shown.
  const showAdvanced = advancedOpen || (query !== "" && fields.advancedMatches);

  return (
    <AccordionItem value={section.id} id={`settings-${section.id}`} hidden={hidden} className="scroll-mt-24 [&[hidden]]:hidden">
      <SectionHeader section={section} summary={props.summary} dirty={props.dirty} badge={props.badge} panelId={panelId} />
      <div
        id={panelId}
        role="region"
        aria-labelledby={`settings-${section.id}-title`}
        hidden={!open}
        className="flex flex-col gap-6 pb-6 animate-overlay-in motion-reduce:animate-none [&[hidden]]:hidden"
      >
        {lede ? <p className="max-w-prose text-sm text-text-secondary">{lede}</p> : null}
        {before}
        {fields.served.length === 0 ? <p className="text-sm text-text-muted">{SETTINGS_COPY.notServed}</p> : null}
        {fields.main.length > 0 ? (
          <div className="grid gap-x-6 gap-y-6 sm:grid-cols-2">
            {fields.main.map((def) => <SettingField key={def.key} def={def} />)}
          </div>
        ) : null}
        {after}
        {fields.advanced.length > 0 && (query === "" || fields.advancedMatches) ? (
          <AdvancedFields id={advancedId} count={fields.advanced.length} open={showAdvanced} onChange={onAdvancedChange}>
            {fields.advanced.map((def) => <SettingField key={def.key} def={def} />)}
          </AdvancedFields>
        ) : null}
      </div>
    </AccordionItem>
  );
}
