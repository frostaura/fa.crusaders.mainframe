/**
 * P4-3 (review round 4) — the service worker learns which build it belongs to.
 *
 * <p>
 * `public/sw.js` was byte-identical across deploys (a hand-kept `VERSION = "v3"`). A browser
 * installs a new worker only when the worker's own bytes change, so after a deploy no new worker
 * installed, the new build's chunks were never precached (offline pages opened with no code), and
 * `crusaders-assets-v3` gathered every build's files for ever. The build now writes an id into the
 * copy of the worker it ships (`vite.config.ts`, `precacheManifest`): it changes whenever any
 * emitted file or public file changes, so each deploy installs a worker whose caches are named for
 * that build, and its activate step removes every other build's.
 * </p>
 *
 * <p>
 * Unbuilt (the Vite dev server, the unit sandbox) the placeholder stays, which names a cache too:
 * the worker works the same, it just never changes.
 * </p>
 */
export const SW_BUILD_PLACEHOLDER = "__CRUSADERS_BUILD__";

/** The worker as shipped: exactly one placeholder replaced by the build's id, or an error. */
export function stampServiceWorker(source: string, buildId: string): string {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(buildId)) throw new Error(`not a build id: ${buildId}`);
  const count = source.split(SW_BUILD_PLACEHOLDER).length - 1;
  if (count !== 1) throw new Error(`sw.js must carry the build placeholder exactly once (found ${count})`);
  return source.replace(SW_BUILD_PLACEHOLDER, buildId);
}
