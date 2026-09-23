import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Lightbulb } from "@/components/ui/icons";
import { SETTINGS_COPY, SETTINGS_INTRO_KEY } from "@/lib/settingsCopy";
import { focusAfterAction, pageHeading } from "@/lib/focusAfterAction";

/**
 * The first-visit note: how this page works, once (plan R13: "onboarding").
 *
 * <p>
 * Four sentences, not a tour: the page's whole model is "sections, search, (i), nothing saves until
 * you say so", and an admin who has read that once does not need it again. Dismissal is remembered
 * in this browser only — a per-viewer convenience, so every read and write is wrapped: a private
 * window or blocked storage simply shows the note again, and the page works either way.
 * </p>
 */
function wasDismissed(): boolean {
  try {
    return window.localStorage.getItem(SETTINGS_INTRO_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDismissed() {
  try {
    window.localStorage.setItem(SETTINGS_INTRO_KEY, "1");
  } catch {
    // Storage refused: the note comes back next visit, which is the honest fallback.
  }
}

export function SettingsIntro() {
  const [shown, setShown] = useState(() => !wasDismissed());
  if (!shown) return null;
  return (
    <aside
      aria-labelledby="settings-intro-title"
      className="flex flex-col gap-3 rounded-xl border border-border bg-accent-soft p-4 sm:flex-row sm:items-start sm:gap-4"
    >
      <Lightbulb size={24} weight="duotone" aria-hidden="true" className="shrink-0 text-accent-strong" />
      <div className="min-w-0 flex-1">
        <h2 id="settings-intro-title" className="text-sm font-semibold text-text-primary">{SETTINGS_COPY.introTitle}</h2>
        <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-sm text-text-secondary">
          {SETTINGS_COPY.introBody.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        // The button goes with the note, so focus goes to the page heading rather than to <body>.
        onClick={() => { rememberDismissed(); setShown(false); focusAfterAction(pageHeading); }}
      >
        {SETTINGS_COPY.introDismiss}
      </Button>
    </aside>
  );
}
