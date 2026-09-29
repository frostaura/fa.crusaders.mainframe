/**
 * F4.3 — what happens when a page's code cannot be fetched.
 *
 * <p>
 * Every page but the few in the entry chunk is `React.lazy`, so opening one fetches its chunk.
 * That fetch fails in two ordinary situations, and before this both ended on the generic "This
 * page hit a problem" screen, which reads as the app being broken:
 * </p>
 * <ul>
 *   <li><b>No signal</b> — a member opens a page this phone has never fetched. The service worker
 *   now precaches every chunk at install (`precache.json`), so this is the rare case of a worker
 *   installed before that list existed, or a precache that could not finish. The page is told
 *   plainly that it opens when the phone is back online, with a Retry.</li>
 *   <li><b>A deploy happened under an open tab</b> — the tab's module graph names chunk hashes the
 *   server no longer has, and the fetch 404s while the phone is perfectly online. One reload
 *   picks up the new build; a second failure in a row is not reloaded again (a loop is worse than
 *   the boundary), so it falls through to the same Retry screen.</li>
 * </ul>
 */

/** A lazy page's code did not arrive. `offline` decides which sentence the boundary uses. */
export class ChunkLoadError extends Error {
  constructor(public offline: boolean, options?: { cause?: unknown }) {
    super(offline ? "The page's code could not be fetched offline." : "The page's code could not be fetched.", options);
    this.name = "ChunkLoadError";
  }
}

/** Chromium, WebKit and Gecko word a failed dynamic import three different ways. */
const CHUNK_FAILURE = /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Failed to fetch/i;

export function isChunkLoadFailure(err: unknown): boolean {
  if (err instanceof ChunkLoadError) return true;
  return err instanceof Error && CHUNK_FAILURE.test(err.message);
}

/** `sessionStorage`, so one reload per tab per failure run — never a loop, and a new tab starts clean. */
export const CHUNK_RELOAD_KEY = "crusaders.mainframe.chunk-reload";

/**
 * How long a reload for a failed chunk rules out another. Time, not "until a chunk loads": the
 * reloaded page loads OTHER chunks fine before it asks for the missing one again, and clearing the
 * mark on any success was a reload loop (measured in `e2e/offline-routes.spec.ts`). A second deploy
 * inside the window gets the boundary and its Retry, which is a reload the member chose.
 */
export const CHUNK_RELOAD_WINDOW_MS = 5 * 60_000;

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Reloads the page unless this tab already reloaded for a failed chunk inside the window.
 * Returns true when a reload is under way.
 */
export function reloadOnceForNewBuild(reload: () => void = () => window.location.reload()): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? "");
    if (Number.isFinite(last) && last > 0 && Date.now() - last < CHUNK_RELOAD_WINDOW_MS) return false;
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  } catch {
    // No storage means no memory of having reloaded — so no reload, rather than a possible loop.
    return false;
  }
  reload();
  return true;
}

/**
 * Wraps a lazy page's `import()`. A chunk that does not arrive either reloads once (online — a
 * stale deploy) or throws a {@link ChunkLoadError} for the page boundary to explain.
 */
export function loadChunk<T>(load: () => Promise<T>, reload?: () => void): Promise<T> {
  return load().catch(
    (err: unknown) => {
      if (!isChunkLoadFailure(err)) throw err;
      const offline = isOffline();
      // A reload while offline only brings back the same shell and the same missing chunk.
      if (!offline && reloadOnceForNewBuild(reload)) return new Promise<T>(() => {});
      throw new ChunkLoadError(offline, { cause: err });
    },
  );
}

/**
 * Vite's own signal for a failed `<link rel=modulepreload>` or CSS preload of a lazy chunk —
 * the same stale-deploy case, reported as an event instead of a rejected import. Installed once
 * from `main.tsx`.
 */
export function installChunkReload(): void {
  window.addEventListener("vite:preloadError", (event) => {
    if (isOffline()) return; // the import itself will fail and the boundary will say so
    if (reloadOnceForNewBuild()) event.preventDefault();
  });
}
