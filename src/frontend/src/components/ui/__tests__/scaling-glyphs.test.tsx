import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../dropdown-menu";
import { Switch } from "../switch";
import { PassCard } from "../pass-card";
import { UserCircle } from "../icons";

/**
 * R10 (lane FA10) — a glyph beside words grows with the words (the round-8/9 rule, L6-16).
 *
 * <p>
 * A Phosphor `size={16}` is a 16px `width` attribute: at 200 % text it stayed 16px beside 32px
 * words (the member combobox's caret, a field error's mark, the time select's clock, the text
 * link's caret, the calendar's chevrons, the info button's "i"). In `components/ui/` a glyph is
 * sized in rem (`size="1rem"`, 16px at 100 %) or by `SCALING_ICON`; only the Avatar's `size`
 * (a pixel key into its own rem classes) is a number. This scan is a ratchet with no allow-list.
 * </p>
 */
const UI = join(__dirname, "..");

const NUMERIC_GLYPH = /<(?!Avatar\b)[A-Z]\w*\b[^>]*\bsize=\{\d+\}/g;

function primitives(): string[] {
  return readdirSync(UI).filter((name) => name.endsWith(".tsx"));
}

describe("glyphs in components/ui grow with the text", () => {
  it("no primitive draws a glyph at a fixed pixel size", () => {
    const offenders = primitives().flatMap((name) => {
      const source = readFileSync(join(UI, name), "utf8");
      return [...source.matchAll(NUMERIC_GLYPH)].map((m) => `${name}: ${m[0].slice(0, 60)}`);
    });
    expect(offenders).toEqual([]);
  });

  it("a menu row sizes the leading glyph a caller passes in rem (AccountMenu's 16px icons)", () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem><UserCircle size={16} aria-hidden="true" />Profile</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const row = screen.getByRole("menuitem", { name: "Profile" });
    expect(row.className).toContain("[&>svg]:size-4");
  });

  it("the switch's track is pixels like its thumb and travel (a rem track left the thumb mid-way at 200 %)", () => {
    render(<Switch aria-label="Notify" />);
    const track = screen.getByRole("switch", { name: "Notify" });
    expect(track.className).toContain("w-[44px]");
    expect(track.className).not.toMatch(/\bw-11\b/);
  });

  it("the pass card centres on its column by a margin that may go negative — never auto (L10-3)", () => {
    render(<PassCard label="Pass" clubName="Crusaders" qr={<svg />} />);
    const card = screen.getByRole("article", { name: "Pass" });
    // D7: the width stays viewport pixels, so the QR is the same at any text size.
    expect(card.className).toContain("w-[min(calc(100vw-32px),360px)]");
    // An auto margin floors at zero, so a column narrower than the card left it hanging right.
    expect(card.className).not.toContain("mx-auto");
    expect(card.className).toContain("ml-[calc((100%-min(calc(100vw-32px),360px))/2)]");
  });
});
