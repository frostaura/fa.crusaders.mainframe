import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P4-2 (review round 4) — what the SPA image tells a browser about caching the files that are not
 * content-hashed. With no Cache-Control, index.html and precache.json were cached heuristically
 * (~17 hours for a week-old build): after a deploy the phone kept a document naming deleted chunks.
 * Read from the file the image is built with (`Dockerfile` copies it); the backend's
 * `SecurityHeaderPostureTests` reads the same file for the framing headers, and every block that
 * sets a header of its own must repeat those four (nginx does not merge add_header).
 */
const CONF = readFileSync(resolve(__dirname, "../nginx.conf"), "utf8").replace(/#.*$/gm, "");

/** The body of `location <location> { … }`, brace-matched (the manifest's block nests `types { }`). */
function block(location: string): string {
  const escaped = location.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/\s+/g, "\\s+");
  const start = new RegExp(`location\\s+${escaped}\\s*\\{`).exec(CONF);
  expect(start, `no \`location ${location}\` block`).not.toBeNull();
  let depth = 1;
  let at = start!.index + start![0].length;
  const from = at;
  while (depth > 0 && at < CONF.length) {
    if (CONF[at] === "{") depth += 1;
    if (CONF[at] === "}") depth -= 1;
    at += 1;
  }
  return CONF.slice(from, at - 1);
}

const FRAMING = ["X-Frame-Options", "X-Content-Type-Options", "Content-Security-Policy", "Referrer-Policy"];

describe("the un-hashed files are revalidated, never cached on a guess", () => {
  for (const location of ["/", "= /index.html", "= /precache.json", "= /sw.js", "= /theme-boot.js", "= /manifest.webmanifest"]) {
    it(`location ${location} says no-cache and keeps the four framing headers`, () => {
      const body = block(location);
      expect(body).toMatch(/add_header\s+Cache-Control\s+"no-cache"\s+always;/);
      for (const header of FRAMING) expect(body, `${location} drops ${header}`).toContain(`add_header ${header}`);
    });
  }

  it("still caches the hashed assets for a year, with one Cache-Control", () => {
    const body = block("~* \\.(?:js|css|woff2?|ttf|svg|png|jpg|jpeg|gif|ico)$");
    expect(body.match(/Cache-Control/g)).toHaveLength(1);
    expect(body).toContain("max-age=31536000, immutable");
  });
});
