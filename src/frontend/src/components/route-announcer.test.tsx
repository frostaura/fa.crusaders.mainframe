import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { RouteAnnouncer } from "./RouteAnnouncer";
import { NOT_FOUND_PAGE_NAME, knownRoutePatterns, routePageName, routeTitle } from "../lib/routeAnnouncer";
import { ADMIN_NAV_ITEMS } from "./admin/adminNav";

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

  /**
   * And the other direction: a name for a route the router no longer declares is a stale row
   * that makes a moved URL look handled. P2 renamed half the map (/schedule → /bookings,
   * /admin/ledger → /admin/transactions, /reports split); every old path is still DECLARED — as
   * a permanent redirect — and so still named.
   */
  it("names nothing the router does not declare", () => {
    const app = readFileSync(join(SRC, "App.tsx"), "utf8");
    const declared = new Set([...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]));
    const stale = knownRoutePatterns().filter((pattern) => !declared.has(pattern));
    expect(stale, "titles for routes App.tsx does not declare").toEqual([]);
  });

  it("names the new map for what each page is", () => {
    expect(routeTitle("/my-code")).toBe("My Code — Crusaders Mainframe");
    expect(routeTitle("/bookings")).toBe("Bookings — Crusaders Mainframe");
    // P3: the rail's label wins — the title an admin hears is the word they just clicked.
    expect(routeTitle("/admin")).toBe("Overview — Crusaders Mainframe");
    expect(routeTitle("/admin/transactions")).toBe("Transactions — Crusaders Mainframe");
    expect(routeTitle("/admin/reports")).toBe("Reports — Crusaders Mainframe");
    expect(routeTitle("/wallet/activity")).toBe("Wallet activity — Crusaders Mainframe");
    expect(routeTitle("/admin/monitoring/devices")).toBe("Boards — Crusaders Mainframe");
  });

  /**
   * The rail and the announcer name every admin destination with the SAME word. They disagreed
   * ("Member groups" under a rail item called "Groups", "Club reports" under "Reports", "Admin
   * overview" under "Overview"): a screen-reader user clicked one word and heard another.
   * Settings is the one known exception, owned by the Settings rebuild (P6), and listed so the
   * exception cannot spread silently.
   */
  it("announces every admin destination by its rail label", () => {
    const KNOWN_EXCEPTIONS = new Set(["settings"]);
    const mismatched = ADMIN_NAV_ITEMS
      .filter((item) => !KNOWN_EXCEPTIONS.has(item.id))
      .filter((item) => routeTitle(item.path) !== `${item.label} — Crusaders Mainframe`)
      .map((item) => `${item.path}: rail "${item.label}" vs "${routeTitle(item.path)}"`);
    expect(mismatched).toEqual([]);
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
      <MemoryRouter initialEntries={["/bookings"]}>
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
      <MemoryRouter initialEntries={["/bookings"]}>
        <RouteAnnouncer />
        <Nav to="/admin/doors" />
        <Routes>
          <Route path="/bookings" element={<Page title="Bookings" />} />
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
    // And it is still theirs a second later — the retry below must not turn "not now" into
    // "in a hundred milliseconds".
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(field).toHaveFocus();
  });

  /**
   * C-M6 (MED) — the browser's Back button landed the keyboard on `&lt;body&gt;`.
   *
   * <p>
   * Reviewer C filtered the door log and pressed Back. Filtering is done in a
   * `&lt;select&gt;`, so at the moment the route changed focus was inside a control the
   * typing guard protects; the guard declined to move focus and, crucially, declined to try
   * again. The re-render then replaced that control, focus fell to the body, and nothing was
   * ever going to pick it up. "Not while they are typing" has to mean exactly that, and not
   * "not at all".
   * </p>
   */
  it("lands on the heading when the control it was protecting goes away", async () => {
    function Filter({ gone }: { gone: boolean }) {
      return gone ? <p>Filtered</p> : <select aria-label="Outcome"><option>All</option></select>;
    }
    function Screen() {
      const [gone, setGone] = useState(false);
      return (
        <>
          <RouteAnnouncer />
          {/*
            A PATHNAME change, where this used to be a query-string one.

            The retry is the behaviour under test and it is unchanged. The scenario had to
            move because a search-only change is now silent by design — it stopped being a
            navigation at all, so a test that drove one would have been asserting the retry
            against a code path that no longer runs. Back out of a filtered log to the doors
            page is the same journey reviewer C took, one segment further.
          */}
          <Nav to="/admin/doors" />
          <button type="button" onClick={() => setGone(true)}>Replace the filter</button>
          <Page title="Door log" extra={<Filter gone={gone} />} />
        </>
      );
    }

    render(<MemoryRouter initialEntries={["/admin/doors/log"]}><Screen /></MemoryRouter>);

    const filter = screen.getByLabelText("Outcome");
    act(() => { filter.focus(); });
    // The navigation happens while focus is in the select, exactly as Back does.
    act(() => { screen.getByRole("button", { name: "Go" }).click(); });
    expect(filter).toHaveFocus();

    // …and then the page replaces it, which is what leaves focus on the body.
    act(() => { screen.getByRole("button", { name: "Replace the filter" }).click(); });

    await waitFor(() => expect(screen.getByRole("heading", { name: "Door log" })).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  /**
   * A filter is not a navigation.
   *
   * <p>
   * The effect ran on `location.search`, so every filter change on the door log announced the
   * page name again and pulled focus to the `&lt;h1&gt;`. An admin narrowing a filter three
   * times heard "Door log" three times, over whatever they were reading, and lost the keyboard
   * off the control they were using each time. The log's own `role="status"` carries the
   * result count, which is the thing that actually changed.
   * </p>
   */
  it("says nothing and takes nothing when only the query string moves", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/doors/log"]}>
        <RouteAnnouncer />
        <Nav to="/admin/doors/log?outcome=refused" />
        <Page title="Door log" />
      </MemoryRouter>,
    );

    const heading = screen.getByRole("heading", { name: "Door log" });
    const go = screen.getByRole("button", { name: "Go" });
    act(() => { go.focus(); });
    act(() => { go.click(); });

    // Give the retry loop every chance to fire if it were going to.
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });

    expect(screen.getByTestId("route-announcer").textContent).toBe("");
    expect(heading).not.toHaveFocus();
    expect(go).toHaveFocus();
    // The title is still right — it is derived from the path, which has not moved.
    expect(document.title).toBe("Door log — Crusaders Mainframe");
  });

  it("still announces when the path moves, filter or no filter", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/doors/log?outcome=refused"]}>
        <RouteAnnouncer />
        <Nav to="/admin/doors?outcome=refused" />
        <Routes>
          <Route path="/admin/doors/log" element={<Page title="Door log" />} />
          <Route path="/admin/doors" element={<Page title="Doors" />} />
        </Routes>
      </MemoryRouter>,
    );

    act(() => { screen.getByRole("button", { name: "Go" }).click(); });
    await waitFor(() => expect(screen.getByTestId("route-announcer").textContent).toBe("Doors"));
  });

  /**
   * <b>Not `role="status"`.</b> The role is the same live region plus a LANDMARK, and this
   * one is mounted on every route in the product — adding it put a second status landmark on
   * every screen that already had one, and four pages' `getByRole("status")` started matching
   * two nodes. A route announcement is not a page's status; it is the navigation talking.
   */
  it("is one polite region and not a landmark", () => {
    render(
      <MemoryRouter initialEntries={["/bookings"]}>
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
