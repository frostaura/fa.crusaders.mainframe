import fs from "node:fs";
import path from "node:path";

/**
 * FM-12: a checkout whose `node_modules` is older than its `package-lock.json` reads as a
 * catastrophically broken build — 228 tsc errors, a vite build that cannot find a font, 355 failed
 * vitest files — when nothing is wrong but the install. The main checkout sat like that for two
 * months and every lane that ran a gate there reported false regressions.
 *
 * <p>
 * So the config that every gate loads (vite build, vitest, the dev server) asks first: is every
 * DIRECT dependency installed at the version the lockfile pins? Direct ones only — they are what
 * the source imports, and the platform-optional transitive packages (fsevents on Linux) are rightly
 * absent. A mismatch stops the gate with the one sentence that fixes it, instead of a wall of red.
 * </p>
 */
type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
type Lock = { packages?: Record<string, { version?: string }> };

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Every direct dependency whose installed version is not the locked one, as "name: locked → installed". */
export function staleDependencies(root: string): string[] {
  const manifest = readJson<Manifest>(path.join(root, "package.json"));
  const lock = readJson<Lock>(path.join(root, "package-lock.json"));
  if (!manifest || !lock?.packages) return [];
  const names = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})].sort();
  return names.flatMap((name) => {
    const locked = lock.packages?.[`node_modules/${name}`]?.version;
    if (!locked) return [];
    const installed = readJson<{ version?: string }>(path.join(root, "node_modules", name, "package.json"))?.version;
    return installed === locked ? [] : [`${name}: locked ${locked}, installed ${installed ?? "nothing"}`];
  });
}

/** The sentence a gate stops with. */
export function staleDependenciesMessage(stale: readonly string[]): string {
  const shown = stale.slice(0, 8).join("; ");
  const more = stale.length > 8 ? ` and ${stale.length - 8} more` : "";
  return `node_modules does not match package-lock.json (${shown}${more}). Run \`npm ci\` in src/frontend, then run this again.`;
}
