import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { DoorsErrorBoundary } from "./DoorsErrorBoundary";
import { withDoorsBoundary } from "./withDoorsBoundary";
import { renderPage } from "../../test/harness";

/**
 * A1 / E-C1 / C1 — the floor under the doors surface.
 *
 * <p>
 * A reviewer deleted a door, every row it had written arrived with `door: null`, the log page
 * read `.name` off it, and the whole document unmounted: white, with no heading, no sentence
 * and no navigation, for every admin in the club. The null-handling is the fix; this is what
 * catches the next one.
 * </p>
 */

function Explodes(): never {
  throw new Error("door: null");
}

describe("the doors error boundary", () => {
  // React logs a caught render error, twice, and it is noise rather than signal here.
  beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("shows a heading, a sentence and a way back instead of a blank page", () => {
    renderPage(<DoorsErrorBoundary><Explodes /></DoorsErrorBoundary>);

    expect(screen.getByRole("heading", { name: "This page could not be shown" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing at the doors has changed");
    expect(screen.getByRole("link", { name: "Back to Doors" })).toHaveAttribute("href", "/admin/monitoring/doors");
    expect(screen.getByRole("button", { name: "Reload this page" })).toBeInTheDocument();
  });

  /**
   * <b>It must not reassure.</b> A screen that has just failed to read its own data is in no
   * position to tell an admin the doors are reporting — that is the "0 doors" family of false
   * claim, from the one screen that has proved it cannot see.
   */
  it("claims nothing about whether the doors are working", () => {
    renderPage(<DoorsErrorBoundary><Explodes /></DoorsErrorBoundary>);

    for (const claim of [/reporting/i, /all doors/i, /working/i, /fine/i]) {
      expect(screen.queryByText(claim)).toBeNull();
    }
  });

  /** The chrome above the route is untouched, which is the whole reason it is not around App. */
  it("leaves everything rendered outside it alone", () => {
    renderPage(
      <div>
        <nav aria-label="Sections">the tab strip</nav>
        <DoorsErrorBoundary><Explodes /></DoorsErrorBoundary>
      </div>,
    );

    expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "This page could not be shown" })).toBeInTheDocument();
  });

  it("renders its children untouched when nothing throws", () => {
    renderPage(<DoorsErrorBoundary><p>the real page</p></DoorsErrorBoundary>);

    expect(screen.getByText("the real page")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "This page could not be shown" })).toBeNull();
  });

  it("wraps a page component at its own export", () => {
    const Guarded = withDoorsBoundary(Explodes);
    renderPage(<Guarded />);

    expect(screen.getByRole("heading", { name: "This page could not be shown" })).toBeInTheDocument();
  });
});
