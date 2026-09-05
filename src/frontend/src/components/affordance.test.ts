import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * "Every clickable surface gets the same subtle affordance the fingerprint icon has."
 *
 * <p>
 * That was the founder's own request, and it is not a thing a rendering test can see:
 * jsdom applies no stylesheet, computes no Tailwind, and reports every element as
 * having no hover state whatever the CSS says. So this pins the two facts the request
 * actually rests on, both of which ARE checkable — that the base layer carrying the
 * affordance exists, and that every clickable surface in the product is the kind of
 * element that layer reaches.
 * </p>
 *
 * <p>
 * The second half is the load-bearing one. One rule keyed on the element rather than a
 * prop on each primitive is only equivalent to "every clickable surface" while nothing
 * is made clickable by hanging an <code>onClick</code> on a bare div — which is exactly
 * the drift that would put the product back where it started, one screen at a time,
 * with nothing going red.
 * </p>
 */
const SRC = join(__dirname, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue; }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Source with its comments blanked out, keeping every offset intact.
 *
 * Comments in this codebase are prose about JSX, so they are full of `<button>` and
 * `<div>` — and the backward walk to an attribute's owning tag lands in the nearest one
 * of those and reports the wrong element. It found `<button>` inside a paragraph
 * explaining why a div was NOT a button, and passed the div. Blanked rather than
 * deleted so every index still lines up with the file.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^([ \t]*)\/\/.*$/gm, (m, indent: string) => indent + " ".repeat(m.length - indent.length));
}

/**
 * The tag an attribute at `at` belongs to: its name and its full opening text.
 *
 * The end of the tag is the first `>` that is NOT the tail of an arrow function — the
 * naive search stops inside `onClick={(e) => …}` and hands back a truncated tag, which
 * silently exempts every attribute written after a handler.
 */
function owningTag(source: string, at: number): { name: string; text: string } {
  const open = source.lastIndexOf("<", at);
  const name = source.slice(open + 1).match(/^[A-Za-z][\w.]*/)?.[0] ?? "";
  let end = open;
  do { end = source.indexOf(">", end + 1); } while (end > 0 && source[end - 1] === "=");
  return { name, text: source.slice(open, end < 0 ? source.length : end + 1) };
}

describe("the affordance every clickable surface shares", () => {
  const css = readFileSync(join(SRC, "index.css"), "utf8");

  it("is one base rule keyed on the element, not a prop on each primitive", () => {
    // An affordance applied per component is one a NEW component silently does not get,
    // which is how the product ended up with a real hover-and-focus treatment on the
    // fingerprint control and on nothing else.
    for (const selector of ['button,', '[role="button"],', "a[href],", "[data-interactive]"]) {
      expect(css).toContain(selector);
    }
    expect(css).toMatch(/cursor:\s*pointer/);
    expect(css).toMatch(/transform:\s*translateY\(-1px\)/);
  });

  it("puts a visible ring on keyboard focus, and only on keyboard focus", () => {
    // :focus-visible, never :focus. A ring on every mouse click is noise that authors
    // then remove wholesale, taking the keyboard user's ring with it — which is how a
    // codebase ends up with no focus indication at all.
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid/);
    expect(css).not.toMatch(/[^-]:focus\s*\{/);
  });

  it("marks a disabled control as unpressable rather than pretending", () => {
    expect(css).toMatch(/button:disabled[\s\S]{0,80}cursor:\s*not-allowed/);
  });

  it("stands down for anyone who asked for less motion, and wins the specificity fight", () => {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const reduced = bare.slice(bare.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).not.toBe("");
    expect(reduced).toMatch(/transform:\s*none/);
    // The shadow is the other half of the lift. Removing one and leaving the other reads as a
    // rendering fault rather than as a hover state.
    expect(reduced).toMatch(/box-shadow:\s*none/);

    // The assertion above used to be the whole test, and it passed while the override did
    // nothing at all. It read `button:hover` — specificity (0,1,1) — against a base rule of
    // `button:not(:disabled):not([aria-disabled="true"]):hover` — (0,3,1). A media query adds no
    // specificity, so the base rule won every time: measured on a live page under
    // `prefers-reduced-motion: reduce`, a hovered grid cell still reported
    // `transform: matrix(1, 0, 0, 1, 0, -1)`, and because the transition had dropped to 1ms it
    // now SNAPPED the pixel instead of easing it — worse than the motion being overridden.
    //
    // Parity is the fix, so parity is what is checked: every selector the lift rule uses has to
    // appear, character for character, inside the reduced-motion block.
    const lift = bare.match(/([^{}]*)\{\s*transform:\s*translateY\(-1px\)/);
    expect(lift).not.toBeNull();
    const liftSelectors = lift![1].split(",").map((s) => s.trim()).filter((s) => s.endsWith(":hover"));
    expect(liftSelectors.length).toBeGreaterThan(1);
    for (const selector of liftSelectors) {
      expect(reduced, `reduced motion does not override "${selector}" at equal specificity`)
        .toContain(selector);
    }
  });

  it("reaches everything clickable, because nothing clickable is a bare div", () => {
    // Imported primitives that ARE the element, or render exactly one.
    const primitives = new Set([
      "button", "Button", "a", "Link", "NavLink", "select", "summary", "label", "input",
      "option", "ConfirmButton",
    ]);
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const source = withoutComments(readFileSync(file, "utf8"));
      for (let i = source.indexOf("onClick="); i !== -1; i = source.indexOf("onClick=", i + 1)) {
        const { name, text: tag } = owningTag(source, i);
        if (primitives.has(name)) continue;
        // A div made clickable is fine as long as it SAYS so — the base rule keys on the
        // role or on `data-interactive`, and a screen reader needs the same declaration
        // for the same reason.
        if (/role="button"|role="tab"|data-interactive/.test(tag)) continue;
        // A dialog backdrop dismissing on a click outside is not a surface that should
        // advertise itself as pressable, and neither is a wrapper that only stops a click
        // from reaching one.
        if (/aria-modal|role="dialog"/.test(tag) || /onClick=\{\(e\) => e\.stopPropagation\(\)\}/.test(tag)) continue;
        // A local wrapper — <IconAction>, <Chip>, <MenuItem> — is covered when what it
        // renders is covered. Resolved rather than allow-listed by name, so a new wrapper
        // that renders a bare div is caught instead of being waved through by a spelling.
        const decl = source.indexOf(`function ${name}(`);
        if (decl !== -1 && /<(button|a)\b/.test(source.slice(decl, decl + 1200))) continue;
        offenders.push(`${file.slice(SRC.length + 1)}: <${name} onClick>`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps white-on-scrim overlays legible over whatever photo is underneath", () => {
    // The profile photo's hover overlay is white 12px text on `bg-black/40`. Over a mid-tone
    // upload that composites to rgb(153,153,153) — 2.85:1, measured, against the 4.5:1 floor —
    // and the image underneath is a member's own file, so it can be anything including white.
    //
    // The worst case is what the alpha has to survive. White text needs the composite at or
    // below rgb(119,119,119); over a pure-white photo, `255 × (1 − a) ≤ 119` gives `a ≥ 0.53`.
    // Hence the floor below, rather than a number chosen because it looked right on one avatar.
    const profile = readFileSync(join(SRC, "pages", "Profile.tsx"), "utf8");
    const scrims = [...profile.matchAll(/bg-black\/(\d+)/g)].map((m) => Number(m[1]));
    expect(scrims.length).toBeGreaterThan(0);
    for (const alpha of scrims) expect(alpha).toBeGreaterThanOrEqual(53);
  });

  it("does not buy the affordance back with contrast", () => {
    // E-F08: `text.muted` (#94A3B8) is already 2.56:1 on white where AA asks 4.5:1, and
    // the grid's time label is the only thing on the booking screen that says what time
    // a slot is. Fading a token that already fails — `text-text-muted/50` and friends —
    // is the one change a visual pass most easily makes and least easily notices.
    const grid = readFileSync(join(SRC, "components", "ScheduleCells.tsx"), "utf8");
    expect(grid).not.toMatch(/text-text-(muted|secondary)\//);
  });
});
