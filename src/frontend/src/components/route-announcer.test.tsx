import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { RouteAnnouncer } from "./RouteAnnouncer";
import { NOT_FOUND_PAGE_NAME, routePageName, routeTitle } from "../lib/routeAnnouncer";

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * C6 — what happens when this app changes page, which until now was nothing.
 *
 * <p>
 * Reviewer C measured a navigation on seven routes: `document.title` stayed "Crusaders
 * Mainframe" on every one, focus went to `&lt;body&gt;`, and nothing was announced. To a
 * screen-reader user a single-page app that does that has not navigated at all.
 * </p>
 */

/** A page shell shaped like the real one: a focusable main with the page's own h1 inside it. */
function Page({ title, extra }: { title: string; extra?: React.ReactNode }) {
  return (
    <main id="main-content" tabIndex={-1}>
      <h1>{title}</h1>
      {extra}
    </main>
  );
}

function Nav({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(to)}>Go</button>;
}

describe("per-route document titles", () => {
  /**
   * <b>The suite guard.</b> A title table is a thing a new route can be left out of, silently,
   * and the failure is invisible to whoever added the route — their tab says the previous
   * page's title and they read it as the browser being slow. So the table is reconciled
   * against `App.tsx` itself rather than against a second list somebody has to remember to
   * update: every `path=` in the router has to resolve to a name that is not the 404's.
   */
  it("names every route the router declares", () => {
    const app = readFileSync(join(SRC, "App.tsx"), "utf8");
    const paths = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(20);

    for (const path of paths) {
      if (path === "*") continue;
      // `:param` segments are filled with something a real URL could hold.
      const concrete = path.split("/").map((s) => (s.startsWith(":") ? "abc123" : s)).join("/");
      expect(routePageName(concrete), `no title for route ${path}`).not.toBe(NOT_FOUND_PAGE_NAME);
    }
  });

  it("puts the page first and the product second, and names an unknown path honestly", () => {
    expect(routeTitle("/admin/doors")).toBe("Doors — Crusaders Mainframe");
    // Declaration order is documentation; specificity is what decides. `/admin/doors/log`
    // must not be read as a door id, which is the same trap the router's own table carries
    // a comment about.
    expect(routeTitle("/admin/doors/log")).toBe("Door log — Crusaders Mainframe");
    expect(routeTitle("/admin/doors/2c9f/card")).toBe("Door card — Crusaders Mainframe");
    expect(routeTitle("/nothing/here")).toBe("Page not found — Crusaders Mainframe");
  });
});

describe("RouteAnnouncer", () => {
  it("titles the document on the first paint without announcing or grabbing focus", () => {
    render(
      <MemoryRouter initialEntries={["/schedule"]}>
        <RouteAnnouncer />
        <Page title="Bookings" />
      </MemoryRouter>,
    );

    expect(document.title).toBe("Bookings — Crusaders Mainframe");
    // A first paint is a real page load: the browser has already announced the document and
    // put focus at the top of it. Saying it again is a second announcement of something that
    // just happened.
    expect(screen.getByTestId("route-announcer").textContent).toBe("");
    expect(document.body).toHaveFocus();
  });

  it("retitles, announces and moves focus to the page heading on a route change", async () => {
    render(
      <MemoryRouter initialEntries={["/schedule"]}>
        <RouteAnnouncer />
        <Nav to="/admin/doors" />
        <Routes>
          <Route path="/schedule" element={<Page title="Bookings" />} />
          <Route path="/admin/doors" element={<Page title="Doors" />} />
        </Routes>
      </MemoryRouter>,
    );

    act(() => { screen.getByRole("button", { name: "Go" }).click(); });

    await waitFor(() => expect(document.title).toBe("Doors — Crusaders Mainframe"));
    expect(screen.getByTestId("route-announcer").textContent).toBe("Doors");
    const heading = screen.getByRole("heading", { name: "Doors" });
    expect(heading).toHaveFocus();
    // `tabindex=-1` so it is focusable and still not a tab stop; `data-route-heading` is what
    // `index.css` keys the scroll-margin and the mouse/keyboard ring distinction on.
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(heading).toHaveAttribute("data-route-heading");
  });

  /**
   * C15 / D9 — a fragment scrolled and did not move focus, so the person it was for carried
   * on reading wherever they already were; and the heading landed underneath the sticky
   * header, measured at y = −29 and y = −335.
   */
  it("focuses the heading a hash names, not the top of the page", async () => {
    render(
      <MemoryRouter initialEntries={["/profile"]}>
        <RouteAnnouncer />
        <Nav to="/profile#door-history" />
        <Page
          title="Profile"
          extra={<section id="door-history"><h2>Your door history</h2></section>}
        />
      </MemoryRouter>,
    );

    act(() => { screen.getByRole("button", { name: "Go" }).click(); });

    await waitFor(() => expect(screen.getByRole("heading", { name: "Your door history" })).toHaveFocus());
    expect(screen.getByRole("heading", { name: "Profile" })).not.toHaveFocus();
    expect(screen.getByRole("heading", { name: "Your door history" })).toHaveAttribute("data-route-heading");
  });

  /**
   * A route change can come from a search box or a date field writing to the query string.
   * A heading that grabs focus mid-sentence is a worse bug than the one this fixes.
   */
  it("never takes focus off something a person is typing into", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/doors/log"]}>
        <RouteAnnouncer />
        <Nav to="/admin/doors/log?outcome=refused" />
        <Page title="Door log" extra={<input aria-label="Filter" />} />
      </MemoryRouter>,
    );

    const field = screen.getByLabelText("Filter");
    act(() => { field.focus(); });
    act(() => { screen.getByRole("button", { name: "Go" }).click(); });

    await waitFor(() => expect(document.title).toBe("Door log — Crusaders Mainframe"));
    expect(field).toHaveFocus();
  });

  /**
   * <b>Not `role="status"`.</b> The role is the same live region plus a LANDMARK, and this
   * one is mounted on every route in the product — adding it put a second status landmark on
   * every screen that already had one, and four pages' `getByRole("status")` started matching
   * two nodes. A route announcement is not a page's status; it is the navigation talking.
   */
  it("is one polite region and not a landmark", () => {
    render(
      <MemoryRouter initialEntries={["/schedule"]}>
        <RouteAnnouncer />
        <Page title="Bookings" />
      </MemoryRouter>,
    );

    const region = screen.getByTestId("route-announcer");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).not.toHaveAttribute("role");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
