import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Link } from "react-router-dom";
import { Interactable } from "../interactable";
import { components, cssVariables, type WatermarkSurface } from "@/lib/tokens";

const strict = { reactStrictMode: true };
const UI = join(__dirname, "..");
const SRC = join(UI, "..", "..");
const CSS = readFileSync(join(UI, "watermark.css"), "utf8");

/** The glyph an Interactable appended, if any. */
function glyphIn(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(".wm-glyph");
}

describe("Interactable", () => {
  it("keeps the child's element type and name, and adds the surface's watermark", () => {
    render(
      <Interactable asChild surface="cell" watermark>
        <button type="button">Book</button>
      </Interactable>,
      strict,
    );
    const button = screen.getByRole("button", { name: "Book" });
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("data-watermark", "cell");
    expect(button).toHaveAttribute("data-interactive");
    expect(button.className).toContain("relative isolate overflow-hidden");
    const glyph = glyphIn(button);
    expect(glyph, "the glyph is appended INSIDE the child").not.toBeNull();
    expect(button.lastElementChild).toBe(glyph);
    expect(button.textContent).toBe("Book");
  });

  it("works on a router Link and stays a link", () => {
    render(
      <MemoryRouter>
        <Interactable asChild surface="card" watermark>
          <Link to="/members/1">Sam Ndlovu</Link>
        </Interactable>
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "Sam Ndlovu" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/members/1");
    expect(link).toHaveAttribute("data-watermark", "card");
  });

  it("carries no watermark unless asked — the Never list is longer than the Carries list", () => {
    render(
      <Interactable asChild surface="tile">
        <button type="button">Open door</button>
      </Interactable>,
    );
    const button = screen.getByRole("button", { name: "Open door" });
    expect(button).not.toHaveAttribute("data-watermark");
    expect(button).toHaveAttribute("data-surface", "tile");
    expect(glyphIn(button)).toBeNull();
  });

  it("renders a div host without asChild", () => {
    const { container } = render(<Interactable watermark surface="card"><span>Court 2</span></Interactable>);
    const host = container.firstElementChild as HTMLElement;
    expect(host.tagName).toBe("DIV");
    expect(host).toHaveAttribute("data-watermark", "card");
    expect(glyphIn(host)).not.toBeNull();
  });
});

describe("Watermark glyph", () => {
  const surfaces: WatermarkSurface[] = ["cell", "card", "tile", "cta"];

  it.each(surfaces)("is decorative and placed from the %s geometry token", (surface) => {
    render(
      <Interactable asChild surface={surface} watermark>
        <button type="button">Go</button>
      </Interactable>,
    );
    const glyph = glyphIn(screen.getByRole("button", { name: "Go" }))!;
    const geometry = components.watermarkGeometry[surface];
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(glyph).toHaveAttribute("data-wm-glyph", surface);
    // An empty box: nothing to read, focus or tab to (an inline SVG needed focusable="false").
    expect(glyph.tagName).toBe("SPAN");
    expect(glyph.childNodes).toHaveLength(0);
    expect(glyph.style.width).toBe(`${geometry.size}px`);
    expect(glyph.style.height).toBe(`${geometry.size}px`);
    expect(glyph.style.right).toBe(`${geometry.right}px`);
    expect(glyph.style.bottom).toBe(`${geometry.bottom}px`);
  });

  it("is cut to Phosphor's FingerprintSimple, light weight — the glyph it replaced, byte for byte", () => {
    // Perf lane (2026-09-30): the per-cell inline SVG became a CSS mask. Same path, same viewBox,
    // painted in currentColor — so the look cannot drift from the icon it was.
    const defs = readFileSync(join(SRC, "..", "node_modules", "@phosphor-icons", "react", "dist", "defs", "FingerprintSimple.es.js"), "utf8");
    const light = /\n {2}\[\n {4}"light",([\s\S]*?)\n {2}\]/.exec(defs)?.[1] ?? "";
    const phosphorPath = /d: "([^"]+)"/.exec(light)?.[1];
    expect(phosphorPath, "Phosphor's light fingerprint").toBeTruthy();
    const mask = /--wm-shape: url\("data:image\/svg\+xml,([^"]+)"\);/.exec(CSS)?.[1] ?? "";
    const svg = decodeURIComponent(mask);
    expect(svg).toBe(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'><path d='${phosphorPath}'/></svg>`);
    expect(CSS).toMatch(/\.wm-glyph \{[^}]*background-color: currentColor;[^}]*mask-image: var\(--wm-shape\);/);
  });

  it("reads only opacity variables the token plugin actually emits, in both themes", () => {
    const named = [...CSS.matchAll(/var\((--wm-[a-z]+-[a-z]+)\)/g)].map((m) => m[1]);
    expect(named.length).toBe(12);
    for (const theme of ["light", "dark"] as const) {
      const declared = cssVariables(theme);
      for (const name of named) expect(declared[name], `${theme}: ${name}`).toBeDefined();
    }
  });

  it("hides in forced colours and print, and moves only when motion is welcome", () => {
    expect(CSS).toMatch(/@media \(forced-colors: active\) \{\s*\.wm-glyph \{ display: none; \}/);
    expect(CSS).toMatch(/@media print \{\s*\.wm-glyph \{ display: none; \}/);
    // Every transform change lives under `no-preference`; outside it only the resting -15deg.
    const outside = CSS.replace(/@media \(prefers-reduced-motion: no-preference\)[^{]*\{[\s\S]*?\n\}/g, "");
    expect([...outside.matchAll(/transform:\s*([^;]+);/g)].map((m) => m[1])).toEqual(["rotate(-15deg)"]);
    // Hover only where a pointer can hover.
    expect(CSS).not.toMatch(/^\[data-watermark\][^{]*:hover/m);
  });
});

describe("Watermark hidden states (the stylesheet, applied)", () => {
  let style: HTMLStyleElement;
  beforeAll(() => {
    style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
  });
  afterAll(() => style.remove());

  function displayOf(attrs: Record<string, string | boolean>) {
    render(
      <Interactable asChild surface="cell" watermark>
        <button type="button" {...attrs}>Slot</button>
      </Interactable>,
    );
    return getComputedStyle(glyphIn(screen.getByRole("button", { name: "Slot" }))!).display;
  }

  it("shows at rest", () => {
    expect(displayOf({})).not.toBe("none");
  });

  it.each([
    ["selected", { "aria-selected": "true" }],
    ["toggled on", { "data-state": "on" }],
    ["busy", { "aria-busy": "true" }],
    ["aria-disabled", { "aria-disabled": "true" }],
    ["disabled", { disabled: true }],
  ])("is hidden when the host is %s", (_, attrs) => {
    expect(displayOf(attrs)).toBe("none");
  });
});

describe("Watermark placement", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it("is imported by ui/interactable.tsx and nothing else", () => {
    const importers = sources(SRC)
      .filter((file) => /from\s+["'][^"']*\/watermark["']/.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file));
    expect(importers).toEqual(["components/ui/interactable.tsx"]);
  });
});
