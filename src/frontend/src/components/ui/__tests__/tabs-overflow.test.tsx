import { describe, expect, it } from "vitest";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Tabs, TabsList, TabsTrigger } from "../tabs";

/**
 * L12-3 (round 12) — a tab list wider than its box says so. At 320 px / 200 % text the four
 * /admin/results tabs scrolled with nothing to show that "Confirmed" and "Removed" existed; the
 * member-detail tabs (ScrollArea) fade the edge that has more past it. One behaviour for every
 * scrolling tab list: the list fades out at that edge (a mask, so it melts into any surface).
 * jsdom drops `mask-image`, so the paint is checked in e2e/shell-r12-fa12.spec.ts; here, the state.
 */

/** jsdom lays nothing out: give the list the box a phone would. */
function lay(el: HTMLElement, box: { scrollWidth: number; clientWidth: number; scrollLeft?: number }) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: box.scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: box.clientWidth });
  Object.defineProperty(el, "scrollLeft", { configurable: true, writable: true, value: box.scrollLeft ?? 0 });
}

function Results({ listRef }: { listRef?: React.Ref<HTMLDivElement> }) {
  return (
    <Tabs variant="underline" defaultValue="disputed">
      <TabsList ref={listRef} aria-label="Results">
        <TabsTrigger value="disputed">Disputed</TabsTrigger>
        <TabsTrigger value="recent">Recent</TabsTrigger>
        <TabsTrigger value="confirmed">Confirmed</TabsTrigger>
        <TabsTrigger value="removed">Removed</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

describe("TabsList overflow cue (L12-3)", () => {
  it("fades the end that has more tabs past it, and only that end", () => {
    render(<Results />);
    const list = screen.getByRole("tablist", { name: "Results" });
    lay(list, { scrollWidth: 557, clientWidth: 256 });
    fireEvent.scroll(list);
    expect(list).toHaveAttribute("data-overflow", "end");

    lay(list, { scrollWidth: 557, clientWidth: 256, scrollLeft: 120 });
    fireEvent.scroll(list);
    expect(list).toHaveAttribute("data-overflow", "start end");

    lay(list, { scrollWidth: 557, clientWidth: 256, scrollLeft: 301 });
    fireEvent.scroll(list);
    expect(list).toHaveAttribute("data-overflow", "start");
  });

  it("a list that fits has no cue at all", () => {
    render(<Results />);
    const list = screen.getByRole("tablist", { name: "Results" });
    lay(list, { scrollWidth: 300, clientWidth: 300 });
    fireEvent.scroll(list);
    expect(list).not.toHaveAttribute("data-overflow");
  });

  it("still hands the caller its ref (PlayerPicker measures its list)", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Results listRef={ref} />);
    expect(ref.current).toBe(screen.getByRole("tablist", { name: "Results" }));
  });
});
