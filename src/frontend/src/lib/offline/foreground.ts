/**
 * The app came back to the member's attention: the tab became visible, the window took focus, or
 * the phone found a network again. One listener set for the whole app, so every cached read can
 * refresh itself on the same moment (`useCachedRead`) without each page wiring three events.
 */
const subscribers = new Set<() => void>();
let wired = false;

function fire() {
  for (const fn of [...subscribers]) fn();
}

function wire() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") fire(); });
  window.addEventListener("focus", fire);
  window.addEventListener("online", fire);
}

/** Calls `fn` whenever the app returns to the foreground. Returns the unsubscribe. */
export function onForeground(fn: () => void): () => void {
  wire();
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}
