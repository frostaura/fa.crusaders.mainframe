import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * FA-1, the fourth time: no `href` may point at the API.
 *
 * <p>
 * A link navigation carries no Authorization header, so the API cannot resolve a tenant and
 * answers `400 tenant_unresolved` as JSON — the download cancels itself and nothing on the page
 * changes. The wallet CSV, the door log, the night and then Faults and the change record all
 * shipped it. Every file is fetched with the token (`DownloadCsvButton`, `fetchCsv`); this scan
 * fails on an `href` whose value is an API path or a `…Url(` builder of one.
 * </p>
 */

const ROOT = __dirname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const API_HREF = /href=\{?\s*[`"'][^`"']*\/api\/|href=\{[^}]*CsvUrl\(/;

describe("no link points at the API", () => {
  it("has no href to an /api/ path or a CSV URL builder anywhere in the source", () => {
    const offenders = sources(ROOT).flatMap((file) => readFileSync(file, "utf8").split("\n")
      .map((line, i) => ({ line, at: `${relative(ROOT, file)}:${i + 1}` }))
      .filter(({ line }) => API_HREF.test(line))
      .map(({ at, line }) => `${at}: ${line.trim()}`));
    expect(offenders).toEqual([]);
  });

  it("would catch the defect it is here for", () => {
    expect(API_HREF.test('<a href={adminEndpoints.monitoringErrorsCsvUrl(filterQuery(filters))}>')).toBe(true);
    expect(API_HREF.test('<a href="/api/v1/admin/changes.csv">')).toBe(true);
    expect(API_HREF.test('<a href={`/api/v1/reports/me/wallet.csv`}>')).toBe(true);
    expect(API_HREF.test('<a href="/admin/monitoring/faults">')).toBe(false);
  });
});
