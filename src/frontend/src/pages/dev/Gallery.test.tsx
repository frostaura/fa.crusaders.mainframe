import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { renderPage } from "@/test/harness";
import Gallery from "@/pages/DevPrimitives";
import { SECTIONS } from "./registry";
import { BARREL_ICONS } from "./IconsSection";

/**
 * The gallery's own behaviour — deep links, the page-theme switch, and that every section mounts
 * under StrictMode. What the primitives LOOK like (contrast, geometry, forced colours) is a layout
 * engine's question and lives in `e2e/gallery.spec.ts`.
 */
const strict = { reactStrictMode: true } as const;

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.search}</output>;
}

function open(search = "") {
  return renderPage(
    <Routes>
      <Route path="/dev/primitives" element={<><Gallery /><Where /></>} />
    </Routes>,
    { ...strict, initialEntries: [`/dev/primitives${search}`] },
  );
}

const sectionIds = () =>
  Array.from(document.querySelectorAll("[data-gallery-section]")).map((el) => el.getAttribute("data-gallery-section"));

afterEach(() => {
  document.documentElement.classList.remove("dark");
});

describe("the gallery", () => {
  // Every section of the gallery in one jsdom tree: one role scan for the h2s rather than one
  // per section (each `getByRole` walks the whole tree), and a budget that holds under a full,
  // parallel suite — it measured 8s against the 5s default there, and under 2s alone.
  it("shows every section, in index order, when no section is asked for", () => {
    open();
    expect(screen.getByRole("heading", { level: 1, name: "Primitives" })).toBeInTheDocument();
    expect(sectionIds()).toEqual(SECTIONS.map((s) => s.id));
    const titles = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    for (const entry of SECTIONS) expect(titles).toContain(entry.title);
  }, 20_000);

  it("shows only the deep-linked section, and marks it current in the index", () => {
    open("?section=buttons");
    expect(sectionIds()).toEqual(["buttons"]);
    const index = screen.getByRole("navigation", { name: "Gallery sections" });
    expect(within(index).getByRole("link", { name: "Buttons and links" })).toHaveAttribute("aria-current", "page");
    expect(within(index).getByRole("link", { name: "All sections" })).not.toHaveAttribute("aria-current");
  });

  it("ignores an unknown section rather than showing nothing", () => {
    open("?section=nope");
    expect(sectionIds()).toHaveLength(SECTIONS.length);
  });

  it("keeps the page theme in every index link", () => {
    open("?section=grid&theme=dark");
    const index = screen.getByRole("navigation", { name: "Gallery sections" });
    expect(within(index).getByRole("link", { name: "Icons" }).getAttribute("href")).toBe("/dev/primitives?section=icons&theme=dark");
  });

  it("paints the page dark from the deep link, and puts it back on leaving", () => {
    const view = open("?section=data&theme=dark");
    expect(document.documentElement).toHaveClass("dark");
    view.unmount();
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("switches the page theme through the URL, without touching the stored choice", async () => {
    open("?section=data");
    const group = screen.getByRole("radiogroup", { name: "Page theme" });
    fireEvent.click(within(group).getByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("?section=data&theme=dark"));
    expect(document.documentElement).toHaveClass("dark");
    expect(window.localStorage.getItem("crusaders:theme")).toBeNull();
    fireEvent.click(within(group).getByRole("radio", { name: "System" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("?section=data"));
    expect(screen.getByTestId("where")).not.toHaveTextContent("theme");
  });

  it("renders static specimens in a light and a dark panel side by side", () => {
    open("?section=data");
    const panels = Array.from(document.querySelectorAll("[data-theme-panel]"));
    expect(panels.map((p) => p.getAttribute("data-theme-panel"))).toEqual(["light", "dark", "light", "dark", "light", "dark", "light", "dark"]);
    expect(panels.every((p) => p.classList.contains(p.getAttribute("data-theme-panel")!))).toBe(true);
  });
});

describe("the sections", () => {
  it("lists every icon the barrel exports, in four weights", () => {
    open("?section=icons");
    expect(BARREL_ICONS.length).toBeGreaterThan(40);
    const light = document.querySelector('[data-theme-panel="light"]')!;
    expect(light.querySelectorAll('[data-weight="duotone"]')).toHaveLength(BARREL_ICONS.length);
    expect(within(light as HTMLElement).getByText("FingerprintSimple")).toBeInTheDocument();
  });

  it("shows every contrast pair passing its floor in both themes", () => {
    open("?section=foundations");
    expect(document.querySelectorAll('[data-contrast="fail"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-contrast="pass"]').length).toBeGreaterThan(40);
  });

  it("hides the watermark on selected, busy and disabled hosts only by their real attributes", () => {
    open("?section=watermark");
    const light = document.querySelector('[data-theme-panel="light"]')!;
    expect(light.querySelectorAll('[data-watermark][data-demo-state="hover"]')).toHaveLength(4);
    expect(light.querySelectorAll('[data-watermark][data-demo-state="press"]')).toHaveLength(4);
    expect(light.querySelectorAll('[data-watermark][aria-busy="true"]')).toHaveLength(4);
    expect(light.querySelectorAll('[data-watermark]:disabled')).toHaveLength(4);
    expect(light.querySelectorAll('[data-watermark][data-state="on"]')).toHaveLength(4);
  });

  it("puts every slot state on the mini grid, with the watermark only on actionable cells", () => {
    open("?section=grid");
    const light = document.querySelector('[data-theme-panel="light"]')!;
    const kinds = new Set(Array.from(light.querySelectorAll("[data-slot-kind]")).map((el) => el.getAttribute("data-slot-kind")));
    for (const kind of ["available", "selected", "mine", "on-court", "mine-past", "booked", "past", "hold", "closed", "restricted", "idle"]) {
      expect(kinds.has(kind), kind).toBe(true);
    }
    for (const cell of Array.from(light.querySelectorAll("[data-slot-kind]"))) {
      const actionable = cell.tagName === "BUTTON";
      expect(cell.hasAttribute("data-watermark"), cell.getAttribute("data-slot-kind")!).toBe(actionable);
    }
    expect(light.querySelector("[data-now-line]")).not.toBeNull();
  });

  it("drives useAsyncAction by hand: pending, then resolved; pending, then rejected", async () => {
    open("?section=feedback");
    const status = () => document.querySelector("[data-async-status]")!;
    const save = screen.getByRole("button", { name: "Save" });
    fireEvent.click(save);
    await waitFor(() => expect(status()).toHaveAttribute("data-async-status", "pending"));
    expect(save).toHaveAttribute("aria-busy", "true");
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(status()).toHaveAttribute("data-async-status", "success"));
    expect(await screen.findByText("Saved (demo).")).toBeInTheDocument();

    fireEvent.click(save);
    await waitFor(() => expect(status()).toHaveAttribute("data-async-status", "pending"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reject" })); });
    await waitFor(() => expect(status()).toHaveAttribute("data-async-status", "error"));
    expect(status()).toHaveTextContent(/save the demo/);
  });

  it("keeps the three test ids the segmented-tabs spec measures", () => {
    open("?section=legacy");
    for (const id of ["tabs-two", "tabs-disabled", "tabs-long"]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });
});
