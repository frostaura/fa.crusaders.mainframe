import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import { settingAnchorId } from "@/lib/tenantSettings";
import { SETTINGS_COPY } from "@/lib/settingsCopy";
import type { Blocker } from "./draft";

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
            {" — "}{blocker.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SaveBar(props: SaveBarProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { changes, blockers, pending, onSave, onDiscard, onFocusSetting } = props;
  const summaryId = useId();
  const [announcement, setAnnouncement] = useState("");
  const blocked = blockers.length > 0;
  if (changes === 0 && !blocked) return null;

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
    <div data-save-bar="" className="pointer-events-none fixed inset-x-0 z-actionbar px-4" style={OFFSET}>
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
  );
}
