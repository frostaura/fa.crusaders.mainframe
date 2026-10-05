import { useLayoutEffect, useRef } from "react";

/**
 * R14 L14-3 — which member CARDS give the name a line of its own.
 *
 * <p>
 * A card's who column is at least half the card (`minmax(50%,1fr)`, L6-9), and beside the avatar
 * that left a name 110–146px at 390–1440: a long single-word surname ("Wolfeschlegelstein") broke
 * mid-word. Chromium's `hyphens: auto` never splits a Capitalised word (measured), so the only cure
 * is room: a card whose name has a word wider than that floor puts the who across the first line
 * and the balance under it, beside the badges (`data-long-name`, `MembersTable`'s `LONG_*`). Every
 * other card keeps its ~72px two-line shape (R5 §4.3).
 * </p>
 *
 * <p>
 * The test is the FLOOR, not the width the name has now — a long card's name is wider than the
 * floor, so judging by the current width would flip the card back and forth. Words are what the
 * name breaks at: spaces, and after a hyphen. Measured with a canvas in the link's own font, so it
 * follows the text size; re-run whenever the list's box changes (a resize, a text-size change, a
 * page of rows). The table (48rem) and the narrow card (under 20rem) already give the name the
 * row; the attribute is harmless there, because every `LONG_*` rule is scoped to the card range.
 * </p>
 */
export function useLongNameCards() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    const ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext?.("2d") ?? null;
    if (!root || !ctx || typeof ResizeObserver === "undefined") return;
    const mark = () => {
      for (const row of root.querySelectorAll<HTMLElement>("tr[data-member-row]")) {
        const name = row.querySelector<HTMLElement>("[data-member-name]");
        const cell = name?.closest("td");
        if (!name || !cell) continue;
        const long = longestWord(ctx, name) > nameFloor(row, cell, name);
        if (long !== row.hasAttribute("data-long-name")) row.toggleAttribute("data-long-name", long);
      }
    };
    const observer = new ResizeObserver(mark);
    observer.observe(root);
    mark();
    void document.fonts?.ready.then(mark);
    return () => observer.disconnect();
  }, []);
  return ref;
}

/**
 * At a space, and after a hyphen. Built from a string, not a literal: lizard's lexer reads a
 * literal's lookbehind as the start of something it never closes (gotchas-gates).
 */
const BREAKS = new RegExp("\\s+|(?<=-)", "u");

/** The widest piece the name can break into — at spaces, and after a hyphen. */
function longestWord(ctx: CanvasRenderingContext2D, name: HTMLElement): number {
  const style = getComputedStyle(name);
  ctx.font = style.font;
  const words = (name.textContent ?? "").split(BREAKS).filter(Boolean);
  return Math.max(0, ...words.map((w) => ctx.measureText(w).width));
}

/** The name's width when the who column is at its floor: half the card's content box, less what sits before the name. */
function nameFloor(row: HTMLElement, cell: HTMLElement, name: HTMLElement): number {
  const box = getComputedStyle(row);
  const content = row.clientWidth - parseFloat(box.paddingLeft) - parseFloat(box.paddingRight);
  const before = name.getBoundingClientRect().left - cell.getBoundingClientRect().left;
  return content / 2 - before;
}
