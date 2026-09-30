import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { settingAnchorId } from "@/lib/tenantSettings";
import { SETTINGS_COPY } from "@/lib/settingsCopy";
import { afterCaption, type Blocker } from "./draft";
import { IconButton } from "@/components/ui/icon-button";
import { CheckCircle, X } from "@/components/ui/icons";
import { pageHeading } from "@/lib/focusAfterAction";

/**
 * The sticky save bar — "3 unsaved changes · Discard · Save changes" (plan R13).
 *
 * <p>
 * <b>It appears when there is something to save, or something stopping a save.</b> Floating
 * rather than at the foot of the page: the page used to end in its Save button, ~5 400 px below
 * the door fields, so an admin who changed one number had to go and find the button, and one who
 * broke a field was told so at a distance. Fixed to the bottom, clear of the phone's tab bar by
 * the same rule as `ui/action-bar` — the shell publishes the bar's height as
 * `--app-bottom-bar-height` (safe area included), and the offset is the larger of that and the
 * safe area plus 12px. That offset is an inline style rather than an arbitrary class because it is
 * a calculation over a runtime variable, not a spacing value.
 * </p>
 *
 * <p>
 * <b>Why Save is never `disabled`.</b> (B5) A disabled button leaves the tab order, so the one
 * control carrying the explanation was the one a keyboard user could not reach. `aria-disabled`
 * keeps it focusable and leaves the press free to do something useful: take the admin to the
 * field that stopped it, and say so. The blocked treatment is `warning.strong` on `warning.soft`
 * with a `warning.strong` edge — both measured ≥ AA in `tokens.test.ts`, and re-measured on the
 * painted pixels by `e2e/admin-settings-validation.spec.ts`.
 * </p>
 *
 * <p>
 * <b>Every blocker is named, beside Save, in the words its field wears</b> (C11), each a real link
 * that focuses the field — opening its section on the way.
 * </p>
 */
export type SaveBarProps = {
  changes: number;
  blockers: Blocker[];
  pending: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onFocusSetting: (key: string) => void;
  /** After a save: what the bar keeps saying until the next edit (F3-4). */
  savedNote?: string | null;
  onDismissSaved?: () => void;
};

const OFFSET = { bottom: "calc(max(var(--app-bottom-bar-height, 0px), env(safe-area-inset-bottom, 0px)) + 12px)" };

const BLOCKED = "border-warning-strong bg-warning-soft text-warning-strong hover:bg-warning-soft";

function BlockerList({ id, blockers, onFocusSetting }: { id: string; blockers: Blocker[]; onFocusSetting: (key: string) => void }) {
  return (
    <div id={id} className="max-h-40 overflow-y-auto rounded-lg border border-warning-strong bg-warning-soft p-3 text-sm text-warning-strong">
      <p className="font-semibold">{SETTINGS_COPY.blockers(blockers.length)}</p>
      <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5">
        {blockers.map((blocker) => (
          <li key={blocker.key}>
            {/* A real link with a real href, so it can be tabbed to and read as one — but the jump
                is ours, because focusing the input is the point and a fragment only scrolls. */}
            <a
              href={`#${settingAnchorId(blocker.key)}`}
              className="font-semibold underline underline-offset-2"
              onClick={(event) => { event.preventDefault(); onFocusSetting(blocker.key); }}
            >{blocker.label}</a>
            {/* The caption is the link; a message that opens with it goes on from there (F3-4). */}
            {afterCaption(blocker.label, blocker.message) ?? ` — ${blocker.message}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * While the bar floats over the page, the page scrolls a focused field ABOVE it (F3.23: on a
 * phone the bar covered the field being typed in). `scroll-padding-bottom` on the document is
 * what the browser honours when it scrolls a focused control into view.
 */
/**
 * The element that actually scrolls the page. On the app shell it is `<main>` (overflow-auto), not
 * the document — measured at 390 in review round 2 (F3-14): the padding set only on `<html>` since
 * F3.23 was never read by anything, which is why the bar still covered the field being fixed.
 */
function pageScroller(): HTMLElement[] {
  const out: HTMLElement[] = [document.documentElement];
  for (let el = document.getElementById("main-content"); el; el = el.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) { out.push(el); break; }
  }
  return out;
}

function useKeepFieldsClearOfBar(shown: boolean, bar: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = bar.current;
    if (!shown || !el) return undefined;
    const scrollers = pageScroller();
    const apply = () => {
      const top = el.getBoundingClientRect().top;
      for (const scroller of scrollers) scroller.style.scrollPaddingBottom = `${Math.max(0, window.innerHeight - top) + 16}px`;
      // The padding only counts when the browser scrolls a control INTO view; a bar that appears
      // or grows (a blocker list) over the field already being typed in moved nothing, and at 390
      // it covered the very field it named (F3-14). Lift that field above the bar's new top.
      const focused = document.activeElement as HTMLElement | null;
      if (!focused || el.contains(focused) || !focused.matches("input, textarea, select, [role=combobox]")) return;
      // The field's own complaint counts, not only its box (R3 V-13): at 1280 the input cleared
      // the bar and the error under it — the sentence saying what to fix — was covered.
      const error = focused.closest("[data-setting], [data-slot=field]")?.querySelector<HTMLElement>("[data-slot=field-error]");
      const target = error ?? focused;
      if (target.getBoundingClientRect().bottom > top) target.scrollIntoView?.({ block: "nearest" });
    };
    apply();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    observer?.observe(el);
    window.addEventListener("resize", apply);
    // R4 V-13: a Tab onto a field at the bottom edge scrolled the FIELD clear of the bar (the
    // padding above) and left its complaint under it. After the browser's own scroll, lift the
    // complaint too.
    let frame = 0;
    const onFocus = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(apply); };
    document.addEventListener("focusin", onFocus);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", apply);
      document.removeEventListener("focusin", onFocus);
      cancelAnimationFrame(frame);
      for (const scroller of scrollers) scroller.style.scrollPaddingBottom = "";
    };
  }, [shown, bar]);
}

/**
 * Where focus lands when a save empties the bar (F4.7's settings half, review round 2 F3-4).
 *
 * <p>
 * A save — or a discard — empties the change count and the bar's buttons go, and the Save the
 * admin pressed took focus to <body> with it. It used to land on a 1×1 screen-reader-only line
 * that emptied itself three seconds later: a sighted keyboard user had focus on nothing they could
 * see. After a save the bar stays as a VISIBLE status saying so — until the next edit or its ×
 * — and focus lands on it; after a discard (no note) focus goes to the page heading.
 * </p>
 */
function useFocusLanding(buttonsShown: boolean, noteShown: boolean) {
  const inside = useRef(false);
  const status = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (buttonsShown || !inside.current) return;
    inside.current = false;
    if (noteShown) status.current?.focus();
    else pageHeading()?.focus();
  }, [buttonsShown, noteShown]);
  return {
    status,
    onFocus: () => { inside.current = true; },
    onBlur: (e: React.FocusEvent) => {
      // Leaving to somewhere else on the page is a real move; only a removal lands here.
      if (e.relatedTarget) inside.current = false;
    },
  };
}

/** The saved state of the bar: visible, focusable, and there until the next edit or its ×. */
function SavedStatus({ note, onDismiss, landing }: {
  note: string; onDismiss?: () => void; landing: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 z-actionbar px-4" style={OFFSET}>
      <div
        ref={landing}
        tabIndex={-1}
        role="status"
        data-save-landing=""
        className="pointer-events-auto mx-auto flex w-full max-w-screen-sm items-center gap-3 rounded-2xl border border-success-strong bg-bg-raised p-3 text-sm font-semibold text-success-strong shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-accent-strong"
      >
        <CheckCircle aria-hidden="true" className="size-5 shrink-0" weight="fill" />
        <p className="min-w-0 flex-1">{note}</p>
        {onDismiss ? (
          <IconButton label={SETTINGS_COPY.dismissSaved} onClick={onDismiss}><X aria-hidden="true" /></IconButton>
        ) : null}
      </div>
    </div>
  );
}

export function SaveBar(props: SaveBarProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { changes, blockers, pending, onSave, onDiscard, onFocusSetting, savedNote, onDismissSaved } = props;
  const summaryId = useId();
  const [announcement, setAnnouncement] = useState("");
  const blocked = blockers.length > 0;
  const shown = changes > 0 || blocked;
  const bar = useRef<HTMLDivElement>(null);
  useKeepFieldsClearOfBar(shown, bar);
  const landing = useFocusLanding(shown, Boolean(savedNote));
  if (!shown) return savedNote ? <SavedStatus note={savedNote} onDismiss={onDismissSaved} landing={landing.status} /> : null;

  const press = () => {
    if (!blocked) {
      setAnnouncement("");
      onSave();
      return;
    }
    const first = blockers[0];
    setAnnouncement(SETTINGS_COPY.movedTo(first.label));
    onFocusSetting(first.key);
  };

  return (
    <>
    <div
      ref={bar}
      data-save-bar=""
      className="pointer-events-none fixed inset-x-0 z-actionbar px-4"
      style={OFFSET}
      onFocus={landing.onFocus}
      onBlur={landing.onBlur}
    >
      <section
        aria-label={SETTINGS_COPY.saveBarLabel}
        className="pointer-events-auto mx-auto flex w-full max-w-screen-sm flex-col gap-3 rounded-2xl border border-border bg-bg-raised p-3 text-text-primary shadow-lg animate-sheet-up motion-reduce:animate-none"
      >
        {blocked ? <BlockerList id={summaryId} blockers={blockers} onFocusSetting={onFocusSetting} /> : null}
        {/* Two rows on a phone (what is pending, then the two buttons), one from `sm`: a headline
            squeezed beside two buttons at 375px wrapped a word per line. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          <div className="min-w-0 basis-full pl-1 sm:basis-0 sm:flex-1">
            <p className="text-sm font-semibold tabular-nums">
              {blocked ? SETTINGS_COPY.cannotSave : SETTINGS_COPY.changes(changes)}
            </p>
            <p className="hidden text-xs text-text-secondary sm:block">{SETTINGS_COPY.savedHint}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
          {changes > 0 ? (
            <ConfirmDialog
              trigger={<Button variant="ghost" disabled={pending}>{SETTINGS_COPY.discard}</Button>}
              title={SETTINGS_COPY.discardTitle}
              description={SETTINGS_COPY.discardBody(changes)}
              confirmLabel={SETTINGS_COPY.discardConfirm}
              cancelLabel={SETTINGS_COPY.keepEditing}
              onConfirm={onDiscard}
            />
          ) : null}
          <Button
            onClick={press}
            pending={pending}
            aria-disabled={blocked || undefined}
            aria-describedby={blocked ? summaryId : undefined}
            className={blocked ? BLOCKED : undefined}
          >{SETTINGS_COPY.save}</Button>
          </div>
        </div>
        {/* The press itself, announced: a control that swallows a press with no feedback is
            indistinguishable, from the person's side, from a broken page. */}
        <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      </section>
    </div>
    </>
  );
}
