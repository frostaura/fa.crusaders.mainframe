import { useEffect, useState } from "react";
import { OFFLINE_COPY } from "./offlineCopy";

/** After this long without an answer the wait has stopped being ordinary — the session splash's 4 s. */
export const STILL_TRYING_AFTER_MS = 4000;

/**
 * R9 X9-6 — drawn beside a page's first-read skeleton (nothing kept on the phone). Against a
 * connection that is accepted and never answered, the skeleton pulsed for the whole 20 s request
 * budget before the offline notice, saying nothing. After {@link STILL_TRYING_AFTER_MS} it says
 * the app is still trying; it goes with the skeleton when the read lands or fails.
 */
export function StillTrying() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), STILL_TRYING_AFTER_MS);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div role="status" aria-live="polite" data-still-trying="">
      {slow ? <p className="text-sm text-text-secondary">{OFFLINE_COPY.stillTrying}</p> : null}
    </div>
  );
}
