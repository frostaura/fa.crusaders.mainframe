import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { InviteListSkeleton } from "./InviteCard";

/**
 * R16 L16-3 sweep (every skeleton) — the invite list's skeleton text column is a flex item beside a
 * fixed avatar; without `min-w-0` its percentage bars size from content and the column can overflow
 * the card at 320 / 200 %. It shrinks like the real card's column.
 */
describe("the invite list's skeleton column can shrink (R16 L16-3 sweep)", () => {
  it("every text column is min-w-0", () => {
    const { container } = render(<InviteListSkeleton />);
    const columns = [...container.querySelectorAll("div.flex-1.flex-col")];
    expect(columns).toHaveLength(3);
    columns.forEach((c) => expect(c.className).toMatch(/\bmin-w-0\b/));
  });
});
