import { useCallback, useEffect, useRef, useState } from "react";

/** How long a URL-bound text field waits after the last keystroke before it writes the URL. */
export const URL_TEXT_DELAY_MS = 250;

/**
 * A text field bound to a URL parameter (R15 L15-2): the field owns what was typed, the URL hears
 * about it once typing pauses.
 *
 * <p>
 * <b>Why:</b> the members search (`?q=`) and the ledger's name search read their value straight from
 * the URL and wrote it on every keystroke. A URL write is a router navigation, committed a render
 * later; a key landing before it commits is typed into the OLD value, and React then resets the
 * field to the URL — "bartholomew" typed at ~80 ms a key came out "brtholomew". Local state takes
 * every key; the URL is written after {@link URL_TEXT_DELAY_MS} of quiet (still `replace`, still
 * shareable).
 * </p>
 *
 * <p>
 * A URL value that changes for any other reason — "Clear filters", Back, a link with `?q=` — is
 * adopted and cancels a pending write; the echo of this field's own write is not.
 * </p>
 */
export function useUrlText(urlValue: string, write: (next: string) => void, delayMs = URL_TEXT_DELAY_MS) {
  const [text, setText] = useState(urlValue);
  const [seenUrl, setSeenUrl] = useState(urlValue);
  /** The last value this field wrote to the URL, until the URL shows it (its own echo). */
  const [sent, setSent] = useState<string | null>(null);
  /** Counts URL moves that were not this field's own echo. */
  const [moved, setMoved] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writeRef = useRef(write);
  const urlRef = useRef(urlValue);
  useEffect(() => { writeRef.current = write; urlRef.current = urlValue; });

  // The URL moved — adjusted during render (React's "state from a changed prop"), not an effect late.
  // Its own echo is not adopted: keys typed since the write would be lost.
  if (urlValue !== seenUrl) {
    setSeenUrl(urlValue);
    setSent(null);
    if (urlValue !== sent) {
      setText(urlValue);
      setMoved((n) => n + 1);
    }
  }

  // Anything else moved the URL ("Clear filters", Back): a write still waiting would undo it.
  useEffect(() => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
  }, [moved]);

  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

  const change = useCallback((next: string) => {
    setText(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (next === urlRef.current) return; // typed back to what the URL says: nothing to write
      setSent(next);
      writeRef.current(next);
    }, delayMs);
  }, [delayMs]);

  return [text, change] as const;
}
