import { useEffect, useRef } from "react";
import { Alert } from "../Alert";
import { Button } from "../ui/button";
import { SETTINGS_COPY } from "../../lib/settingsCopy";

export type ConflictWords = { theirs: string[]; kept: number; clashed: string[] };

/**
 * A save refused as stale (review round 4, A4-1): somebody else saved Settings after this page
 * was read. The page already shows their values with this admin's other edits carried on top;
 * this says so, names what they changed, and — where both changed one setting — offers to put
 * this admin's value back. Saving is still the admin's own press: nothing here re-sends.
 *
 * <p>
 * Brought into view and focused, like the refused-save banner: Save is pressed from the bar at the
 * foot of the screen and this sits at the top.
 * </p>
 */
export function SettingsConflictBanner({ conflict, onReapply, onDismiss }: {
  conflict: ConflictWords;
  onReapply: () => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollIntoView?.({ block: "center" });
    el.focus({ preventScroll: true });
  }, [conflict]);
  return (
    <div ref={ref} tabIndex={-1} data-settings-conflict="" className="scroll-mt-24 outline-none">
      <Alert tone="warning" live="assertive" announceKey={`settings-conflict-${conflict.theirs.join(",")}`}>
        <span className="flex flex-col items-start gap-2">
          <span className="font-medium">{SETTINGS_COPY.conflictTitle}</span>
          {conflict.theirs.length > 0 ? <span>{SETTINGS_COPY.conflictTheirs(conflict.theirs)}</span> : null}
          {conflict.clashed.length > 0 ? <span>{SETTINGS_COPY.conflictClashed(conflict.clashed)}</span> : null}
          {conflict.kept > 0 ? <span>{SETTINGS_COPY.conflictKept(conflict.kept)}</span> : null}
          {conflict.clashed.length > 0 ? (
            <span className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" className="!h-auto min-h-9 whitespace-normal py-1.5 text-left" onClick={onReapply}>
                {SETTINGS_COPY.conflictReapply(conflict.clashed.length)}
              </Button>
              <Button variant="ghost" size="sm" className="!h-auto min-h-9 whitespace-normal py-1.5 text-left" onClick={onDismiss}>
                {SETTINGS_COPY.conflictDismiss}
              </Button>
            </span>
          ) : null}
        </span>
      </Alert>
    </div>
  );
}
