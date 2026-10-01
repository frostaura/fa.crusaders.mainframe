import { afterEach, describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PageShell } from "../page-shell";
import { SplitView } from "../split-view";
import { WithAside } from "../with-aside";
import { AutoGrid, Columns } from "../auto-grid";
import { autoGridTemplate, moveListFocus } from "../layout";
import { ContextBar } from "../context-bar";
import { ActionBar } from "../action-bar";

/**
 * The R4 layout primitives (SPEC 2). jsdom has no layout, so these hold BEHAVIOUR and the classes
 * that produce the geometry; the geometry itself is measured in Chromium at 390/768/1024/1280/1920
 * by `e2e/layout-primitives.spec.ts`.
 */
const strict = { reactStrictMode: true };

afterEach(() => {
  document.documentElement.style.removeProperty("--context-bar-height");
});

describe("PageShell full", () => {
  it("widens to the full frame from 3xl when asked, and tells the app bar so", () => {
    const { container } = render(<PageShell width="wide" fullFrom3xl><p>body</p></PageShell>);
    const shell = container.firstElementChild as HTMLElement;
    expect(shell).toHaveAttribute("data-page-shell", "wide");
    expect(shell).toHaveAttribute("data-page-frame", "full");
    expect(shell.className.split(" ")).toEqual(expect.arrayContaining(["max-w-wide", "3xl:max-w-page"]));
    const plain = render(<PageShell width="wide"><p>body</p></PageShell>).container.firstElementChild!;
    expect(plain).not.toHaveAttribute("data-page-frame");
  });

  it("is the 120rem frame, a named container, with the 3xl gutter", () => {
    const { container } = render(<PageShell width="full"><p>body</p></PageShell>);
    const shell = container.firstElementChild as HTMLElement;
    expect(shell).toHaveAttribute("data-page-shell", "full");
    for (const token of ["max-w-page", "@container/page", "3xl:px-12", "px-4", "lg:px-8"]) {
      expect(shell.className.split(" ")).toContain(token);
    }
  });
});

function Rows({ picked }: { picked?: number }) {
  return (
    <ul>
      {[1, 2, 3].map((n) => (
        <li key={n}>
          <a href={`#${n}`} data-split-item="" aria-current={picked === n ? "page" : undefined}>Row {n}</a>
        </li>
      ))}
    </ul>
  );
}

describe("SplitView", () => {
  it("with nothing picked shows the list, and the placeholder only when split", () => {
    render(<SplitView listLabel="Invites" list={<Rows />} detail={null} placeholder={<p>Pick an invite</p>} />, strict);
    const list = screen.getByRole("region", { name: "Invites" });
    expect(list.className.split(" ")).toContain("flex");
    expect(list.className).not.toContain("hidden");
    const placeholder = screen.getByText("Pick an invite").parentElement!;
    expect(placeholder.className.split(" ")).toEqual(["hidden", "@[64rem]/split:block"]);
  });

  it("with something picked hides the list when stacked, keeps it beside the detail when split", () => {
    render(<SplitView listLabel="Invites" list={<Rows picked={2} />} detail={<h2>Invite 2</h2>} placeholder={<p>Pick</p>} />, strict);
    const list = screen.getByRole("region", { name: "Invites" });
    expect(list.className.split(" ")).toEqual(expect.arrayContaining(["hidden", "@[64rem]/split:flex"]));
    expect(screen.getByRole("heading", { name: "Invite 2" })).toBeInTheDocument();
    expect(screen.queryByText("Pick")).toBeNull();
    // Mounted either way, so the list keeps its filters and scroll while a phone shows the detail.
    expect(within(list).getAllByRole("link")).toHaveLength(3);
  });

  it("splits at the BOX width it is given, with the list pane sticky and self-scrolling", () => {
    const { container } = render(<SplitView listLabel="Members" listWidth="28rem" splitAt="56rem" list={<Rows />} detail={null} />);
    const root = container.querySelector("[data-split-view]")!;
    expect(root.className).toContain("@container/split");
    const grid = root.firstElementChild!;
    expect(grid.className).toContain("@[56rem]/split:grid");
    expect(grid.className).toContain("[--split-list:28rem]");
    const list = screen.getByRole("region", { name: "Members" });
    expect(list.className).toContain("@[56rem]/split:sticky");
    expect(list.className).toContain("@[56rem]/split:overflow-y-auto");
  });

  it("walks the list with Up, Down, Home and End, and leaves a search field's keys alone", () => {
    render(
      <SplitView
        listLabel="Inbox"
        list={<><input aria-label="Search" /><Rows /></>}
        detail={null}
      />,
      strict,
    );
    const links = screen.getAllByRole("link");
    links[0].focus();
    fireEvent.keyDown(links[0], { key: "ArrowDown" });
    expect(links[1]).toHaveFocus();
    fireEvent.keyDown(links[1], { key: "End" });
    expect(links[2]).toHaveFocus();
    fireEvent.keyDown(links[2], { key: "ArrowDown" });
    expect(links[2]).toHaveFocus();
    fireEvent.keyDown(links[2], { key: "Home" });
    expect(links[0]).toHaveFocus();
    fireEvent.keyDown(links[0], { key: "ArrowUp" });
    expect(links[0]).toHaveFocus();
    const search = screen.getByRole("textbox", { name: "Search" });
    search.focus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search).toHaveFocus();
  });

  it("ignores modified arrows and keys it does not own", () => {
    const event = { key: "ArrowDown", altKey: true, ctrlKey: false, metaKey: false, preventDefault: () => { throw new Error("handled"); } };
    expect(() => moveListFocus(event as never)).not.toThrow();
    const tab = { ...event, key: "Tab", altKey: false };
    expect(() => moveListFocus(tab as never)).not.toThrow();
  });
});

describe("WithAside", () => {
  it("is a named complementary landmark after the main column by default", () => {
    const { container } = render(<WithAside asideLabel="Today" aside={<p>Summary</p>}><p>Grid</p></WithAside>, strict);
    const aside = screen.getByRole("complementary", { name: "Today" });
    const main = container.querySelector("[data-aside-main]")!;
    expect(main.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(aside.className).toContain("@[72rem]/aside:sticky");
    expect(container.querySelector("[data-with-aside]")!.className).toContain("@container/aside");
  });

  it("puts a `before` rail first in reading order and in the first column", () => {
    const { container } = render(<WithAside asideLabel="Your balance" placement="before" aside={<p>Balance</p>}><p>Ledger</p></WithAside>);
    const aside = screen.getByRole("complementary", { name: "Your balance" });
    const main = container.querySelector("[data-aside-main]")!;
    expect(aside.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(aside.parentElement!.className).toContain("@[72rem]/aside:grid-cols-[var(--aside-w)_minmax(0,1fr)]");
  });

  it("a `first` rail leads the reading order but stands in the second column, with the tight gap", () => {
    const { container } = render(<WithAside asideLabel="Your games" placement="first" gap="md" aside={<p>Games</p>}><p>Grid</p></WithAside>);
    const aside = screen.getByRole("complementary", { name: "Your games" });
    const main = container.querySelector<HTMLElement>("[data-aside-main]")!;
    expect(aside.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(aside.className).toContain("@[72rem]/aside:col-start-2");
    expect(main.className).toContain("@[72rem]/aside:col-start-1");
    expect(main.className.split(" ")).toContain("gap-4");
    expect(aside.parentElement!.className).toContain("@[72rem]/aside:grid-cols-[minmax(0,1fr)_var(--aside-w)]");
  });

  it("draws a `sheet` rail only beside the main column, and widens from 3xl", () => {
    render(<WithAside asideLabel="Detail" placement="sheet" at="64rem" asideWidth="22rem" aside={<p>Row</p>}><p>Table</p></WithAside>);
    const aside = screen.getByRole("complementary", { name: "Detail" });
    expect(aside.className.split(" ")).toEqual(expect.arrayContaining(["hidden", "@[64rem]/aside:flex"]));
    expect(aside.parentElement!.className).toContain("3xl:[--aside-w:24rem]");
  });

  it("takes a 28rem rail where a catalogue needs it", () => {
    render(<WithAside asideLabel="Catalogue" asideWidth="28rem" aside={<p>Vars</p>}><p>Endpoints</p></WithAside>);
    expect(screen.getByRole("complementary", { name: "Catalogue" }).parentElement!.className).toContain("[--aside-w:28rem]");
  });
});

describe("AutoGrid and Columns", () => {
  it("never makes a tile wider than the box, and caps the columns without a breakpoint", () => {
    expect(autoGridTemplate("card", 3, "md")).toBe("repeat(auto-fill, minmax(max(min(100%, 18rem), calc((100% - 2 * 0.75rem) / 3)), 1fr))");
    expect(autoGridTemplate("stat", undefined, "sm")).toBe("repeat(auto-fill, minmax(min(100%, 9rem), 1fr))");
    expect(autoGridTemplate("panel", 2, "lg", "fit")).toBe("repeat(auto-fit, minmax(max(min(100%, 26rem), calc((100% - 1 * 1rem) / 2)), 1fr))");
  });

  it("renders as a list when asked, with the template and gap inline", () => {
    render(<AutoGrid as="ul" min="card" max={4} aria-label="Badges"><li>One</li><li>Two</li></AutoGrid>);
    const list = screen.getByRole("list", { name: "Badges" });
    expect(list).toHaveAttribute("data-auto-grid", "card");
    expect(list.style.gridTemplateColumns).toContain("18rem");
    expect(list.style.gap).toBe("0.75rem");
  });

  it("flows unequal cards into columns and keeps each card whole", () => {
    const { container } = render(<Columns min="panel" max={3}><section>A</section><section>B</section></Columns>);
    const flow = container.firstElementChild as HTMLElement;
    expect(flow.style.columns).toBe("26rem 3");
    expect(flow.className).toContain("[&>*]:break-inside-avoid");
  });
});

describe("ContextBar", () => {
  it("a top bar is a named strip that shows from its breakpoint", () => {
    render(<ContextBar position="top" label="Activity range" until="lg" summary="Last 30 days" primary={<button type="button">Download CSV</button>} />, strict);
    const bar = screen.getByRole("region", { name: "Activity range" });
    expect(bar.className.split(" ")).toEqual(expect.arrayContaining(["z-sticky", "hidden", "lg:flex"]));
    expect(within(bar).getByText("Last 30 days")).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Download CSV" })).toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue("--context-bar-height")).toBe("");
  });

  /**
   * R5 X5-1 (HIGH): the bar stuck from the `lg` VIEWPORT, so at 1280 with 200 % text a 665px bar
   * held a 744px scroller and no ledger row was ever on screen. It sticks by room now — and while
   * it sticks it publishes its height for the shell's scroll-padding-top (X5-2).
   */
  function inScroller(barHeight: number, room: number, bar: ReactElement) {
    const rect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { ...rect.call(this), height: this.hasAttribute("data-context-bar") ? barHeight : 0 } as DOMRect;
    };
    const restore = () => { HTMLElement.prototype.getBoundingClientRect = rect; };
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "clientHeight", { value: room, configurable: true });
    document.body.appendChild(scroller);
    const view = render(bar, { container: scroller, ...strict });
    return { ...view, restore: () => { view.unmount(); scroller.remove(); restore(); } };
  }

  it("a short top bar sticks, and publishes its height while it does", () => {
    const view = inScroller(90, 744, <ContextBar position="top" label="Filters and totals" summary="All types" />);
    try {
      const bar = screen.getByRole("region", { name: "Filters and totals" });
      expect(bar.className.split(" ")).toEqual(expect.arrayContaining(["sticky", "top-0"]));
      expect(bar).toHaveAttribute("data-sticks");
      expect(document.documentElement.style.getPropertyValue("--context-bar-top-height")).toBe("90px");
    } finally {
      view.restore();
    }
    expect(document.documentElement.style.getPropertyValue("--context-bar-top-height")).toBe("");
  });

  it("a top bar taller than its share of the scroller scrolls away with the page", () => {
    const view = inScroller(665, 744, <ContextBar position="top" label="Filters and totals" summary="All types" />);
    try {
      const bar = screen.getByRole("region", { name: "Filters and totals" });
      expect(bar.className.split(" ")).not.toContain("sticky");
      expect(bar).not.toHaveAttribute("data-sticks");
      expect(bar.className).not.toContain("hidden");
      expect(document.documentElement.style.getPropertyValue("--context-bar-top-height")).toBe("");
    } finally {
      view.restore();
    }
  });

  it("the share a bar may take is the caller's", () => {
    const view = inScroller(200, 744, <ContextBar position="top" label="Filters and totals" stickyMax={0.25} summary="All types" />);
    try {
      expect(screen.getByRole("region", { name: "Filters and totals" })).not.toHaveAttribute("data-sticks");
    } finally {
      view.restore();
    }
  });

  it("a bottom bar docks above the tab bar, hides from its breakpoint, and reserves its room while mounted", () => {
    const rect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { ...rect.call(this), height: this.hasAttribute("data-context-bar") ? 60 : 0 } as DOMRect;
    };
    try {
      const { unmount } = render(<ContextBar position="bottom" label="Wallet actions" until="lg" primary={<button type="button">Top up</button>} />, strict);
      const bar = screen.getByRole("region", { name: "Wallet actions" });
      expect(bar.className).toContain("fixed");
      expect(bar.className).toContain("lg:hidden");
      expect(bar.className).toContain("--app-bottom-bar-height");
      expect(document.documentElement.style.getPropertyValue("--context-bar-height")).toBe("72px");
      unmount();
      expect(document.documentElement.style.getPropertyValue("--context-bar-height")).toBe("");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = rect;
    }
  });

  it("the tallest of two docked bars wins, and the room goes when the last one leaves", () => {
    const rect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      const h = this.hasAttribute("data-action-bar") ? 100 : this.hasAttribute("data-context-bar") ? 50 : 0;
      return { ...rect.call(this), height: h } as DOMRect;
    };
    try {
      const bar = render(<ContextBar position="bottom" label="Wallet actions" primary={<button type="button">Top up</button>} />);
      const selection = render(<ActionBar count={2} onClose={() => {}} />);
      expect(document.documentElement.style.getPropertyValue("--context-bar-height")).toBe("112px");
      selection.unmount();
      expect(document.documentElement.style.getPropertyValue("--context-bar-height")).toBe("62px");
      bar.unmount();
      expect(document.documentElement.style.getPropertyValue("--context-bar-height")).toBe("");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = rect;
    }
  });
});
