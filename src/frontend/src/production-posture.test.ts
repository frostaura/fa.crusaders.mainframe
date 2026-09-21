import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FRONTEND = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = dirname(dirname(FRONTEND));

/**
 * WIRE-R2 §5 / E-C2 — the sign-in screen's dev shortcut, and what stops it shipping.
 *
 * <p>
 * Reviewer E found the login page offering "Sign in as seeded admin" with the seeded
 * account's e-mail and password printed underneath it, and filed it as critical. The
 * orchestrator checked and it is dev-only — the block is behind
 * <code>import.meta.env.DEV || VITE_SHOW_DEV_LOGIN === "true"</code>, the review stack is a
 * dev server, and the account exists only under the Development seeder. Correct, and
 * <b>nothing held it</b>: the claim rested on reading the source, the mechanism is a
 * build-time constant folded by a minifier, and the second half of that condition was an
 * override the image build offered as a one-word change in an unreviewed <code>.env</code>.
 * </p>
 *
 * <p>
 * "It is dev-only" is a property of the artefact, not of the source, so this reads the
 * artefact. Two halves, and the second is the one that was actually false: the bundle must
 * not contain the block or the password, and nothing that builds an image may turn the
 * override on — so the override is gone from the Dockerfile and from compose, and this fails
 * if either comes back.
 * </p>
 */

/** The two strings that must never reach a production bundle. Both are on the login screen. */
const DEV_ONLY_STRINGS = ["Dev shortcuts", "Sign in as seeded admin", "ChangeMeOnFirstLogin!"];

describe("the production frontend bundle", () => {
  it("contains neither the dev shortcut block nor the seeded password", () => {
    const out = mkdtempSync(join(tmpdir(), "crusaders-posture-"));
    // The project's own vite, run directly rather than through `npm run build`: the script
    // also runs `tsc -b`, which is `make lint`'s job and would double this test's cost for
    // nothing it is asking about. Mode `production` is what sets `import.meta.env.DEV` false,
    // which is the whole mechanism under test.
    execFileSync(
      process.execPath,
      [join(FRONTEND, "node_modules", "vite", "bin", "vite.js"), "build", "--mode", "production", "--outDir", out, "--emptyOutDir"],
      {
        cwd: FRONTEND,
        stdio: "pipe",
        /**
         * <b>`NODE_ENV` explicitly, and this test failed without it.</b>
         *
         * Vitest sets `NODE_ENV=test` in its own process, vite leaves an inherited
         * `NODE_ENV` alone, and the child inherits it — so the first run of this test built
         * a bundle carrying React's development build AND the dev-shortcuts block, and
         * reported a defect that only existed inside the test runner. A posture test that
         * builds the artefact has to build the artefact the release builds.
         */
        env: { ...process.env, NODE_ENV: "production" },
      },
    );

    const text = readAll(out).join("\n");
    expect(text.length).toBeGreaterThan(10_000);
    for (const secret of DEV_ONLY_STRINGS) {
      expect(text, `a production bundle contains "${secret}"`).not.toContain(secret);
    }
  }, 180_000);

  /**
   * <b>Tracked files only, and that is deliberate.</b> A developer's own untracked
   * <code>.env</code> is exactly where this override legitimately belongs, and a test that
   * failed on it would be a test everybody learns to ignore. What must never carry it is
   * anything a release is built from.
   */
  it("is built by nothing that can switch the dev shortcut back on", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const buildInputs = tracked.filter((path) => {
      const name = path.split("/").pop()!;
      return name.startsWith(".env")
        || name.startsWith("Dockerfile")
        || /^docker-compose.*\.ya?ml$/.test(name);
    });
    // If this list is empty the test is asserting nothing, which is the failure mode a
    // filename filter has.
    expect(buildInputs.length).toBeGreaterThanOrEqual(5);

    for (const path of buildInputs) {
      const body = readFileSync(join(REPO, path), "utf8");
      // The word may appear in a comment saying it must not be set — which is what the
      // Dockerfile and compose now carry in its place — so the bound is on a SETTING of it.
      const lines = body.split("\n")
        .filter((line) => line.includes("VITE_SHOW_DEV_LOGIN"))
        .filter((line) => !line.trim().startsWith("#"));
      expect(lines, `${path} sets VITE_SHOW_DEV_LOGIN`).toEqual([]);
    }
  });
});

/** Every text file under a directory, read flat. Fonts and images are skipped. */
function readAll(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at)) {
      const full = join(at, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (/\.(js|css|html|json|txt|map)$/.test(entry)) out.push(readFileSync(full, "utf8"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}
