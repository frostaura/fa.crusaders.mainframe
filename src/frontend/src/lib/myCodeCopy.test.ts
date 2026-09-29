import { describe, expect, it } from "vitest";
import { codeUseLine } from "./myCodeCopy";

/**
 * F4.9 — "…and it pays for somebody else's court at the box" read as a charge the code makes on
 * its own. Paying for a friend is something the member chooses at the box, and the line says so.
 */
describe("My Code — what the code is for", () => {
  it.each([true, false])("says paying for a friend is the member's choice (doors: %s)", (doors) => {
    const line = codeUseLine(doors);
    expect(line).toMatch(/lets you pay for a friend's court at the box, when you choose to\.$/);
    expect(line).not.toMatch(/pays for somebody else's court/);
  });
});
