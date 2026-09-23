import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Alert } from "../components/Alert";
import { Accordion } from "../components/ui/accordion";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { Skeleton } from "../components/ui/skeleton";
import { StateBlock } from "../components/ui/state-block";
import { TextLink } from "../components/ui/text-link";
import { type AdminSettings } from "../lib/api";
import { readCurrencySymbol } from "../lib/currency";
import { doorRetentionNotice } from "../lib/doorsCopy";
import { describeDoorBookingHorizon } from "../lib/gateCopy";
import { doorBookingHorizonMinutes } from "../lib/tenantSettings";
import {
  SETTINGS, SETTINGS_SECTIONS, isServed, normaliseQuery, sectionDef, sectionMatches, sectionOfKey, settingDef,
  settingMatches, type SettingContext, type SettingsSectionId,
} from "../lib/settingsSchema";
import { sectionSummary } from "../lib/settingsSummaries";
import { SETTINGS_COPY } from "../lib/settingsCopy";
import { blockersOf, changedKeys, dirtySections } from "../components/settings/draft";
import { SettingsFormProvider, type SettingsForm } from "../components/settings/form";
import { LeaveGuard } from "../components/settings/LeaveGuard";
import { OperatingHours } from "../components/settings/OperatingHours";
import { SaveBar } from "../components/settings/SaveBar";
import { SettingsIntro } from "../components/settings/SettingsIntro";
import { SettingsSection } from "../components/settings/SettingsSection";
import { SettingsToolbar } from "../components/settings/SettingsToolbar";
import { capsSentence, doorHorizonBasis } from "../components/settings/sentences";
import { useSettingFocus } from "../components/settings/useSettingFocus";
import { useSettingsDocument } from "../components/settings/useSettingsDocument";

/**
 * Admin · Settings — ~70 settings made navigable (plan R13: "admin settings overwhelming —
 * expand/collapse sections, onboarding, floating tooltips, decent descriptions").
 *
 * <p>
 * <b>The shape.</b> A search box; ten sections in one accordion, each header carrying a live
 * one-line summary and an "unsaved" mark; inside, one row per setting — caption, (i) for the full
 * story, the right control, one line of description — with rarely-touched settings behind an
 * "advanced" disclosure. A save bar floats up the moment there is something to save, and a leave
 * guard stops the edits walking out of the door. Every fact about a setting comes from the
 * registry (`lib/settingsSchema.ts`); this page wires the working copy to it.
 * </p>
 *
 * <p>
 * <b>Everything that stood before still stands</b>, and the tests that pin it moved with it: an
 * emptied number is empty, not zero (B5); a refused value is said on its field and out loud when
 * the admin leaves it (C12); Save is never `disabled`, and pressing it while blocked takes the
 * admin to the first bad field (B5 / C11); `#setting-<key>` lands on the field (A9); the door
 * horizon is computed and says where it came from (C13); the button map is never sent (it is the
 * Boards screen's); and a key an older API does not serve gets no row and no complaint.
 * </p>
 *
 * <p>
 * <b>Courts moved out</b> to `/admin/courts` — they are records with their own lifecycle, not
 * settings, and a price edit sitting under the same Save as the door policy was two different
 * kinds of change sharing one button.
 * </p>
 */
export default function AdminSettingsPage() {
  const doc = useSettingsDocument();

  if (doc.error) {
    return (
      <PageShell>
        <PageHeader title={SETTINGS_COPY.title} description={SETTINGS_COPY.description} />
        <StateBlock
          error={doc.error}
          action={SETTINGS_COPY.readAction}
          failedCaveat={SETTINGS_COPY.readCaveat}
          onRetry={() => void doc.load()}
        />
      </PageShell>
    );
  }
  if (doc.loading || !doc.draft || !doc.saved) return <SettingsSkeleton />;
  return <SettingsEditor doc={{ ...doc, draft: doc.draft, saved: doc.saved }} />;
}

function SettingsSkeleton() {
  return (
    <PageShell>
      <PageHeader title={SETTINGS_COPY.title} description={SETTINGS_COPY.description} />
      <StateBlock
        loading
        action={SETTINGS_COPY.readAction}
        skeleton={(
          <div className="flex flex-col gap-3">
            <Skeleton className="h-touch" />
            <div className="flex flex-col gap-2 rounded-xl border border-border p-4">
              {SETTINGS_SECTIONS.map((section) => <Skeleton key={section.id} className="h-14" />)}
            </div>
          </div>
        )}
      />
    </PageShell>
  );
}

type Doc = ReturnType<typeof useSettingsDocument> & { draft: AdminSettings; saved: AdminSettings };

/** Which sections are open, by hand and while searching — and how to open one for a jump. */
function useOpenSections(clearQuery: () => void) {
  const [open, setOpen] = useState<string[]>([]);
  const [advanced, setAdvanced] = useState<ReadonlySet<SettingsSectionId>>(new Set());
  // While a search runs every matching section is open, unless the admin closes one; the hand-set
  // state comes back untouched when the search is cleared.
  const [searchOpen, setSearchOpen] = useState<string[] | null>(null);

  const openSection = useCallback((id: SettingsSectionId) => {
    if (!SETTINGS_SECTIONS.some((section) => section.id === id)) return;
    setOpen((current) => (current.includes(id) ? current : [...current, id]));
    setSearchOpen((current) => (current && !current.includes(id) ? [...current, id] : current));
  }, []);

  const setAdvancedOpen = useCallback((id: SettingsSectionId, next: boolean) => {
    setAdvanced((current) => {
      const copy = new Set(current);
      if (next) copy.add(id); else copy.delete(id);
      return copy;
    });
  }, []);

  /**
   * Open whatever hides a setting: its section, its "advanced" disclosure, and any search — a jump
   * to a field the search has filtered out would land on nothing.
   */
  const reveal = useCallback((key: string) => {
    const section = sectionOfKey(key);
    if (!section) return;
    const def = settingDef(key);
    if (def?.advanced) setAdvancedOpen(section, true);
    clearQuery();
    setSearchOpen(null);
    openSection(section);
  }, [openSection, setAdvancedOpen, clearQuery]);

  return { open, setOpen, advanced, setAdvancedOpen, searchOpen, setSearchOpen, openSection, reveal };
}

/** Which settings and sections survive the search. */
function useSearch(query: string, context: SettingContext) {
  return useMemo(() => {
    if (!query) return null;
    const keys = new Set(
      SETTINGS
        .filter((def) => isServed(def, context.settings))
        .filter((def) => sectionMatches(sectionDef(def.section), query) || settingMatches(def, query, context))
        .map((def) => def.key),
    );
    const sections = SETTINGS_SECTIONS
      .filter((section) => sectionMatches(section, query) || SETTINGS.some((def) => def.section === section.id && keys.has(def.key)))
      .map((section) => section.id);
    return { keys, sections };
  }, [query, context]);
}

function SettingsEditor({ doc }: { doc: Doc }) {
  const { draft, saved } = doc;
  const [rawQuery, setRawQuery] = useState("");
  const query = normaliseQuery(rawQuery);
  const clearQuery = useCallback(() => setRawQuery(""), []);
  const sections = useOpenSections(clearQuery);
  const { highlighted, focusSetting } = useSettingFocus(true, sections.reveal, sections.openSection);

  // The symbol the captions wear, read from the working copy: the admin editing it is the one
  // person who should see the page follow as they type. A half-typed value paints the default.
  const currency = readCurrencySymbol(draft.currency_symbol);
  const context = useMemo<SettingContext>(() => ({ settings: draft, currency }), [draft, currency]);
  const blockers = blockersOf(draft, currency);
  const changed = changedKeys(saved, draft);
  const dirty = dirtySections(changed);
  const search = useSearch(query, context);

  const form: SettingsForm = {
    settings: draft,
    update: doc.update,
    errors: Object.fromEntries(blockers.map((blocker) => [blocker.key, blocker.message])),
    highlighted,
    query,
    visible: (key) => !search || search.keys.has(key),
    context,
  };

  const openValue = search ? (sections.searchOpen ?? search.sections) : sections.open;
  const onQueryChange = (next: string) => {
    setRawQuery(next);
    sections.setSearchOpen(null);
  };
  const barShown = changed.length > 0 || blockers.length > 0;

  return (
    <SettingsFormProvider value={form}>
      <PageShell className={barShown ? (blockers.length > 0 ? "pb-80" : "pb-40") : undefined}>
        <PageHeader title={SETTINGS_COPY.title} description={SETTINGS_COPY.description} />
        <SettingsIntro />
        <SettingsToolbar
          query={rawQuery}
          onQueryChange={onQueryChange}
          matches={search?.keys.size ?? 0}
          allOpen={sections.open.length === SETTINGS_SECTIONS.length}
          onToggleAll={() => sections.setOpen(
            sections.open.length === SETTINGS_SECTIONS.length ? [] : SETTINGS_SECTIONS.map((section) => section.id),
          )}
        />
        {search && search.sections.length === 0 ? (
          <NoMatches query={rawQuery.trim()} onClear={() => onQueryChange("")} />
        ) : null}
        <Accordion
          type="multiple"
          value={openValue}
          onValueChange={(next) => (search ? sections.setSearchOpen(next) : sections.setOpen(next))}
          className="rounded-xl border border-border bg-bg-surface px-4 shadow-xs sm:px-6 [&[hidden]]:hidden"
          hidden={search !== null && search.sections.length === 0}
        >
          {SETTINGS_SECTIONS.map((section) => (
            <SettingsSection
              key={section.id}
              section={section}
              open={openValue.includes(section.id)}
              hidden={search !== null && !search.sections.includes(section.id)}
              summary={sectionSummary(section.id, draft, currency)}
              dirty={dirty.has(section.id)}
              advancedOpen={sections.advanced.has(section.id)}
              onAdvancedChange={(next) => sections.setAdvancedOpen(section.id, next)}
              {...sectionExtras(section.id, draft)}
            />
          ))}
        </Accordion>
      </PageShell>
      <SaveBar
        changes={changed.length}
        blockers={blockers}
        pending={doc.save.pending}
        onSave={() => void doc.save.run(draft)}
        onDiscard={doc.discard}
        onFocusSetting={focusSetting}
      />
      <LeaveGuard changes={changed.length} />
    </SettingsFormProvider>
  );
}

function NoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-10 text-center">
      <p className="text-base font-semibold text-text-primary">{SETTINGS_COPY.noMatches(query)}</p>
      <p className="max-w-prose text-sm text-text-secondary">{SETTINGS_COPY.noMatchesHint}</p>
      <Button variant="outline" className="mt-2" onClick={onClear}>{SETTINGS_COPY.clearSearch}</Button>
    </div>
  );
}

/**
 * What a section carries besides its fields: the sentences the page derives, and the notes a
 * section is read under.
 */
function sectionExtras(id: SettingsSectionId, settings: AdminSettings): { before?: ReactNode; after?: ReactNode; badge?: ReactNode } {
  switch (id) {
    case "bookings":
      return {
        after: (
          <div className="flex flex-col gap-1">
            {/* The two caps compose, and neither field alone would say so (ruling 3). */}
            <p className="max-w-prose text-sm text-text-secondary">{capsSentence(settings)}</p>
            {/* The other half of the rule: a group may LOWER either cap for its own members. */}
            <TextLink variant="standalone" to="/admin/groups" className="self-start text-sm">{SETTINGS_COPY.groupsLink}</TextLink>
          </div>
        ),
      };
    case "hours":
      return { after: <OperatingHours /> };
    case "credits":
      return {
        badge: <Badge tone="info">{SETTINGS_COPY.movingToGroups}</Badge>,
        before: <Alert tone="info" live="off">{SETTINGS_COPY.movingToGroupsNote}</Alert>,
      };
    case "doors":
      return { after: <DoorHorizon settings={settings} /> };
    case "records":
      return { after: <RetentionNotice settings={settings} /> };
    default:
      return {};
  }
}

/**
 * The answer itself, rather than three hints and an arithmetic exercise: three fields on two
 * sections decide when a booking QR opens a door, and under the default policy it is none of the
 * three alone — which is how this screen once said 30 while the door said 130.
 */
function DoorHorizon({ settings }: { settings: AdminSettings }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-bg-muted p-4">
      <p className="text-sm font-semibold text-text-primary">
        {describeDoorBookingHorizon(doorBookingHorizonMinutes(settings))}
      </p>
      {/* C13 — and WHERE that number came from. */}
      <p className="text-sm text-text-secondary">{doorHorizonBasis(settings)}</p>
    </div>
  );
}

/** What the door-scan retention means, in the words the door log prints. */
function RetentionNotice({ settings }: { settings: AdminSettings }) {
  // Null while the box is empty (or the API has no such key): the sentence's no-number arm is the
  // honest one then, rather than quoting 90 nobody set.
  const days = Number.isFinite(settings.door_log_retention_days) ? (settings.door_log_retention_days as number) : null;
  return <p className="max-w-prose text-sm font-medium text-text-primary">{doorRetentionNotice(days)}</p>;
}
