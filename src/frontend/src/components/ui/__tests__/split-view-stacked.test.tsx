import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { SplitView } from "../split-view";
import { usePickParam, useSplitLayout, type SplitLayout } from "../use-split-layout";

/**
 * R5 X5-3 / X5-10 — the split view and the page read ONE measure (the box, in rem); stacked, a
 * pick shows a back control, focus goes to the detail's heading and Back returns to the list; a
 * pick is announced. jsdom has no layout: a box of 0 is "stacked", and `getBoundingClientRect` is
 * stubbed for "split". The geometry itself is measured in Chromium (`e2e/split-pick-r5.spec.ts`).
 */
const strict = { reactStrictMode: true };

afterEach(() => { vi.restoreAllMocks(); });

const ROWS = ["a", "b", "c"];

function Page({ onLayout }: { onLayout?: (layout: SplitLayout) => void }) {
  const layout = useSplitLayout("56rem");
  onLayout?.(layout);
  const { value, pick, unpick } = usePickParam("n");
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <p data-testid="where">{`${location.pathname}${location.search}`}</p>
      <button type="button" onClick={() => navigate(-1)}>browser back</button>
      <SplitView
        layout={layout}
        splitAt="56rem"
        listLabel="Things"
        list={(
          <ul>
            {ROWS.map((id) => (
              <li key={id}><button type="button" data-split-item="" onClick={() => pick(id)}>{`Row ${id}`}</button></li>
            ))}
          </ul>
        )}
        detail={value ? <section><h2>{`Thing ${value}`}</h2></section> : null}
        back={{ label: "Back to things", onBack: unpick }}
        pickedKey={value}
        announce={value ? `Showing: Thing ${value}` : undefined}
      />
    </>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={["/before", path]} initialIndex={1}>
      <Routes>
        <Route path="/before" element={<p>the page before</p>} />
        <Route path="/things" element={<Page />} />
      </Routes>
    </MemoryRouter>,
    strict,
  );
}

describe("SplitView stacked (the box under splitAt — a phone, or 200 % text)", () => {
  it("a pick hides the list, shows a back control, focuses the detail's heading and is announced", async () => {
    renderAt("/things");
    expect(document.querySelector("[data-split-view]")).not.toHaveAttribute("data-split");
    fireEvent.click(screen.getByRole("button", { name: "Row b" }));

    const heading = await screen.findByRole("heading", { name: "Thing b" });
    await waitFor(() => expect(heading).toHaveFocus());
    const back = screen.getByRole("button", { name: "Back to things" });
    // Shown only while stacked — CSS decides, so the first paint is right.
    expect(back.className.split(" ")).toContain("@[56rem]/split:hidden");
    expect(screen.getByRole("status")).toHaveTextContent("Showing: Thing b");
    expect(screen.getByRole("region", { name: "Things" }).className.split(" ")).toContain("hidden");
  });

  it("the pick is PUSHED: the phone's Back returns to the list, not off the page", async () => {
    renderAt("/things");
    fireEvent.click(screen.getByRole("button", { name: "Row a" }));
    await screen.findByRole("heading", { name: "Thing a" });
    expect(screen.getByTestId("where")).toHaveTextContent("/things?n=a");

    fireEvent.click(screen.getByRole("button", { name: "browser back" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/things$/));
    expect(screen.queryByRole("heading", { name: "Thing a" })).toBeNull();
  });

  it("the back control returns to the list too — and a deep-linked pick, with no list entry behind it, stays on the page", async () => {
    renderAt("/things?n=c");
    // Opened with the page: the route's to announce, so nothing is said and focus is not moved.
    expect(screen.getByRole("heading", { name: "Thing c" })).not.toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("");

    fireEvent.click(screen.getByRole("button", { name: "Back to things" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/things$/));
    expect(screen.getByRole("button", { name: "Row c" })).toBeInTheDocument();
  });

  it("switching from one pick to another replaces it, so Back still lands on the list", async () => {
    renderAt("/things");
    fireEvent.click(screen.getByRole("button", { name: "Row a" }));
    await screen.findByRole("heading", { name: "Thing a" });
    // Beside the list (split), a second row is picked straight from the first.
    act(() => { screen.getByRole("button", { name: "Row b" }).click(); });
    await screen.findByRole("heading", { name: "Thing b" });
    fireEvent.click(screen.getByRole("button", { name: "Back to things" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/things$/));
  });
});

describe("SplitView split (the box at splitAt or wider)", () => {
  it("the page and the split view read one measure: the box's width against splitAt in rem", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const width = this.hasAttribute("data-split-view") ? 1000 : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0, toJSON: () => ({}) } as DOMRect;
    });
    const seen: boolean[] = [];
    render(
      <MemoryRouter initialEntries={["/things"]}>
        <Routes><Route path="/things" element={<Page onLayout={(l) => seen.push(l.split)} />} /></Routes>
      </MemoryRouter>,
    );
    // 1000px ≥ 56rem × 16px = 896px.
    await waitFor(() => expect(document.querySelector("[data-split-view]")).toHaveAttribute("data-split"));
    expect(seen.at(-1)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Row a" }));
    await screen.findByRole("heading", { name: "Thing a" });
    // Beside the list, focus stays on the row so Up/Down keep walking; the pick is still said.
    expect(screen.getByRole("heading", { name: "Thing a" })).not.toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Showing: Thing a");
  });
});
