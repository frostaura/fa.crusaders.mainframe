import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Perf (R4) — the cancel sheet and the split step stay out of the Bookings page's own chunk. A
 * value import of either from the page (or the book sheet) would pull it back in silently; the
 * bundle is the only other place that would show it.
 */
const read = (path: string) => readFileSync(join(__dirname, "..", "..", "..", path), "utf8");
const valueImport = (source: string, module: string) =>
  new RegExp(`^import\\s+(?!type\\b)[^;]*from\\s+["'][^"']*${module}["']`, "m").test(source);

describe("lazy parts of Bookings", () => {
  it("imports the cancel sheet on the page only as a type", () => {
    const page = read("pages/Schedule.tsx");
    expect(valueImport(page, "bookings/CancelSheet")).toBe(false);
    expect(page).toContain("LazyCancelSheet");
  });

  it("imports the split step in the book sheet only lazily", () => {
    const sheet = read("components/bookings/BookSheet.tsx");
    expect(valueImport(sheet, "/SplitStep")).toBe(false);
    expect(sheet).toContain("LazySplitStep");
  });
});
