import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The founder-facing blueprint may not quote a test count.
 *
 * <p>
 * <code>docs/system-blueprint.html</code> is the page the founder actually reads, and across
 * four revisions it has carried nine different test totals — 686 / 303 / 44, then
 * 668 / 276 / 83, then 800 / 276 / 272 built into a "1348", then 859 / 276 / 376 built into a
 * "1511". Not one survived to the next measurement. The last revision is the clearest case:
 * it set out to fix the stale counts, quoted <b>859</b>, and shipped in the same commit the
 * fourteen new tests that made the true figure 873 — so the page broke its own stated rule
 * ("a number that has not been re-run should be deleted, not carried forward") in the diff
 * that wrote it.
 * </p>
 *
 * <p>
 * That is structural, not carelessness. Counts change on every commit that adds a test; the
 * page is revised every few days; so a count here is stale by construction. Stamping each one
 * with the commit it was measured at would make it <em>true</em> and still useless — a reader
 * cannot act on "873 as of 5e86891" any more than on "873". What a suite <b>covers</b> moves
 * slowly and is the thing a reader needs, so the page describes coverage and this test keeps
 * the numbers from creeping back.
 * </p>
 *
 * <p>
 * Deliberately narrow: it forbids a digit adjacent to a test-suite word, not digits. The page
 * is full of numbers that belong there — 9600 baud, a 90-minute relay cap, GPIO 22/24/26/28,
 * 169.254/16, 40/40 identical QR matrices — and a blanket rule would either be turned off or
 * would teach the next author to spell counts out in words.
 * </p>
 */

const BLUEPRINT = join(__dirname, "..", "..", "..", "docs", "system-blueprint.html");
const html = readFileSync(BLUEPRINT, "utf8");

/** What a reader sees: tags stripped, entities loosened, whitespace flattened. */
const prose = html
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");

/** Each rule is a shape that has actually appeared on this page, with the wording it produced. */
const FORBIDDEN: { why: string; pattern: RegExp }[] = [
  { why: "a count of xUnit / vitest / Unity tests, e.g. \"859 xUnit tests\" or \"376 / 376 vitest\"",
    pattern: /\b\d[\d,]*\s*(?:\/\s*\d[\d,]*\s*)?(?:x?[Uu]nit|vitest|Unity)\b/ },
  { why: "a count of tests, e.g. \"1511 tests, all green\"",
    pattern: /\b\d[\d,]*\s+tests?\b/ },
  { why: "a pass / skip tally, e.g. \"250 skipped, 609 passed\"",
    pattern: /\b\d[\d,]*\s+(?:passed|passing|skipped|failed)\b/ },
  { why: "a file count, e.g. \"across 43 files\"",
    pattern: /\b\d[\d,]*\s+(?:test\s+)?files\b/ },
  { why: "a total assembled from three suite counts, e.g. \"(859 + 276 + 376)\"",
    pattern: /\b\d{2,}\s*\+\s*\d{2,}\s*\+\s*\d{2,}\b/ },
];

describe("docs/system-blueprint.html", () => {
  it("is the page this test thinks it is", () => {
    // A path that stops resolving turns every assertion below into a silent pass — the exact
    // failure mode of a gate that cannot fail, which this repo has already shipped three of.
    expect(html).toContain("Event catalogue");
    expect(prose).toMatch(/Gates — what each suite covers/);
  });

  it.each(FORBIDDEN)("quotes no test count — $why", ({ pattern, why }) => {
    const hit = prose.match(pattern);
    expect(
      hit?.[0] ?? null,
      `docs/system-blueprint.html is quoting ${why} ("${hit?.[0]}"). Counts on this page have ` +
        "been wrong in every revision that carried them, including the one that set out to fix " +
        "them. Say what the suite covers instead — the bullets under \"Gates\" are the pattern.",
    ).toBeNull();
  });

  it("still says how the suites are proved, rather than saying nothing", () => {
    // Removing the numbers must not become removing the section. These are the claims that
    // replaced them, and they are what a reader is left with.
    expect(prose).toMatch(/zero skips/);
    expect(prose).toMatch(/REQUIRE_BOUNDARY_TESTS/);
    expect(prose).toMatch(/Cross-tenant injection cases/);
    expect(prose).toMatch(/ASAN \+ UBSAN/);
    expect(prose).toMatch(/Playwright in real Chromium/);
  });
});
