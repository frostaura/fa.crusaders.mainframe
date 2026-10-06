import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { RouteAnnouncer } from "./RouteAnnouncer";
import { NOT_FOUND_PAGE_NAME, focusFragmentTarget, isRetryLanding, knownRoutePatterns, retryByReload, routePageName, routeTitle } from "../lib/routeAnnouncer";
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
    expect(routeTitle("/my-code")).toBe("My Code — Crusaders Squash");
    expect(routeTitle("/bookings")).toBe("Bookings — Crusaders Squash");
    // P3: the rail's label wins — the title an admin hears is the word they just clicked.
    expect(routeTitle("/admin")).toBe("Overview — Crusaders Squash");
    expect(routeTitle("/admin/transactions")).toBe("Transactions — Crusaders Squash");
    expect(routeTitle("/admin/reports")).toBe("Reports — Crusaders Squash");
    expect(routeTitle("/wallet/activity")).toBe("Wallet activity — Crusaders Squash");
    expect(routeTitle("/admin/monitoring/devices")).toBe("Boards — Crusaders Squash");
    // P6 — the courts left Settings for a page of their own.
    expect(routeTitle("/admin/courts")).toBe("Courts — Crusaders Squash");
  });

  /**
   * P5 — a member's own page. Each tab is a URL, so each is named: an admin with three members'
   * wallets open in three tabs can at least tell the wallet tabs from the night tabs. The id is
   * never read as a word, and "/admin/members/abc" must not fall through to the 404's name.
   */
  it("names a member's page and each of its tabs", () => {
    expect(routeTitle("/admin/members/2c9f")).toBe("Member — Crusaders Squash");
    expect(routeTitle("/admin/members/2c9f/wallet")).toBe("Member wallet & ledger — Crusaders Squash");
    expect(routeTitle("/admin/members/2c9f/bookings")).toBe("Member bookings — Crusaders Squash");
    expect(routeTitle("/admin/members/2c9f/doors")).toBe("Member door history — Crusaders Squash");
    expect(routeTitle("/admin/members/2c9f/night")).toBe("Member's night — Crusaders Squash");
    expect(routeTitle("/admin/members/2c9f/access")).toBe("Member sign-in & biometrics — Crusaders Squash");
  });

  /**
   * The rail and the announcer name every admin destination with the SAME word. They disagreed
   * ("Member groups" under a rail item called "Groups", "Club reports" under "Reports", "Admin
   * overview" under "Overview"): a screen-reader user clicked one word and heard another.
   * Settings was the last exception ("Admin settings"); the Settings rebuild (P6) retired it, so
   * there are none — every destination is heard by the word the rail shows.
   */
  it("announces every admin destination by its rail label", () => {
    const mismatched = ADMIN_NAV_ITEMS
      .filter((item) => routeTitle(item.path) !== `${item.label} — Crusaders Squash`)
      .map((item) => `${item.path}: rail "${item.label}" vs "${routeTitle(item.path)}"`);
    expect(mismatched).toEqual([]);
  });

  it("puts the page first and the product second, and names an unknown path honestly", () => {
    expect(routeTitle("/admin/doors")).toBe("Doors — Crusaders Squash");
    // Declaration order is documentation; specificity is what decides. `/admin/doors/log`
    // must not be read as a door id, which is the same trap the router's own table carries
    // a comment about.
    expect(routeTitle("/admin/doors/log")).toBe("Door log — Crusaders Squash");
    expect(routeTitle("/admin/doors/2c9f/card")).toBe("Door card — Crusaders Squash");
    expect(routeTitle("/nothing/here")).toBe("Page not found — Crusaders Squash");
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

    expect(document.title).toBe("Bookings — Crusaders Squash");
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

    await waitFor(() => expect(document.title).toBe("Doors — Crusaders Squash"));
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

    await waitFor(() => expect(document.title).toBe("Door log — Crusaders Squash"));
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
    expect(document.title).toBe("Door log — Crusaders Squash");
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

/**
 * R13 — a fragment that names an accordion section. The section's header is an `<h2>` wrapping
 * its one button; focus belongs on the button (Enter opens it), never on an inert heading round
 * it. Found in Chromium: the router's fragment jump focused the heading AFTER the settings page
 * had focused the button, so `/admin/settings#settings-doors` left the keyboard on a heading.
 */
/**
 * F4.6 — the member page renders "Member" while it reads, then swaps in its own header. The old
 * `<h1>` left the document with focus on it (focus fell to `<body>`), and the page was announced
 * and titled only as "Member". Focus now follows the heading to its replacement, and a page about
 * one record is named from it.
 */
function LoadingThenNamed({ placeholder, name }: { placeholder: string; name: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <main id="main-content" tabIndex={-1}>
      {loaded ? <header><h1>{name}</h1></header> : <div><h1>{placeholder}</h1></div>}
      <button type="button" onClick={() => setLoaded(true)}>finish reading</button>
    </main>
  );
}

describe("a heading replaced after focus landed (F4.6)", () => {
  function renderMember() {
    render(
      <MemoryRouter initialEntries={["/admin/members"]}>
        <RouteAnnouncer />
        <Nav to="/admin/members/u-1" />
        <Routes>
          <Route path="/admin/members" element={<Page title="Members" />} />
          <Route path="/admin/members/:userId" element={<LoadingThenNamed placeholder="Member" name="Thandi Probe" />} />
        </Routes>
      </MemoryRouter>,
    );
    act(() => { screen.getByRole("button", { name: "Go" }).click(); });
  }

  it("follows the heading to its replacement instead of dropping focus on the body", async () => {
    renderMember();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Member" })).toHaveFocus());
    act(() => { screen.getByRole("button", { name: "finish reading" }).click(); });
    // The click itself put focus on the button in a browser; jsdom does not, so the old heading
    // left the document holding focus — exactly the measured case.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Thandi Probe" })).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("names the member in the tab and the announcement once the page says who", async () => {
    renderMember();
    await waitFor(() => expect(screen.getByTestId("route-announcer").textContent).toBe("Member"));
    act(() => { screen.getByRole("button", { name: "finish reading" }).click(); });
    await waitFor(() => expect(document.title).toBe("Thandi Probe — Member — Crusaders Squash"));
    expect(screen.getByTestId("route-announcer").textContent).toBe("Thandi Probe — Member");
  });

  it("does not take focus back from something the person moved to meanwhile", async () => {
    renderMember();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Member" })).toHaveFocus());
    const finish = screen.getByRole("button", { name: "finish reading" });
    act(() => { finish.focus(); finish.click(); });
    await new Promise((r) => setTimeout(r, 250));
    expect(finish).toHaveFocus();
  });

  it("leaves a page that is not about one record named by the table", async () => {
    render(
      <MemoryRouter initialEntries={["/bookings"]}>
        <RouteAnnouncer />
        <Nav to="/wallet" />
        <Routes>
          <Route path="/bookings" element={<Page title="Bookings" />} />
          <Route path="/wallet" element={<Page title="Your wallet" />} />
        </Routes>
      </MemoryRouter>,
    );
    act(() => { screen.getByRole("button", { name: "Go" }).click(); });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your wallet" })).toHaveFocus());
    expect(document.title).toBe("Wallet — Crusaders Squash");
  });
});

/**
 * F4-10 — the booking page keeps ONE `<h1>` node and changes its words when the read lands
 * ("Booking" → "Court 1 · Thu 1 Oct, 10:15"). Nothing was replaced, so the watcher never looked
 * again and the page stayed titled and announced as just "Booking".
 */
function SameHeadingRenamed() {
  const [loaded, setLoaded] = useState(false);
  return (
    <main id="main-content" tabIndex={-1}>
      <h1>{loaded ? "Court 1 · Thu 1 Oct, 10:15" : "Booking"}</h1>
      <button type="button" onClick={() => setLoaded(true)}>finish reading</button>
    </main>
  );
}

describe("a heading renamed in place after focus landed (F4-10)", () => {
  it("names the booking in the tab and the announcement once its heading says which", async () => {
    render(
      <MemoryRouter initialEntries={["/bookings"]}>
        <RouteAnnouncer />
        <Nav to="/bookings/b-1" />
        <Routes>
          <Route path="/bookings" element={<Page title="Bookings" />} />
          <Route path="/bookings/:bookingId" element={<SameHeadingRenamed />} />
        </Routes>
      </MemoryRouter>,
    );
    act(() => { screen.getByRole("button", { name: "Go" }).click(); });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Booking" })).toHaveFocus());
    act(() => { screen.getByRole("button", { name: "finish reading" }).click(); });

    await waitFor(() => expect(document.title).toBe("Court 1 · Thu 1 Oct, 10:15 — Booking — Crusaders Squash"));
    expect(screen.getByTestId("route-announcer").textContent).toBe("Court 1 · Thu 1 Oct, 10:15 — Booking");
  });
});

/**
 * F4-6 — Retry on an error/offline boundary reloads the page, and the page that opened after it
 * used to leave focus on `<body>` and say nothing: a cold first paint's rule, applied to a
 * navigation the member had just asked for.
 */
describe("the page a boundary's Retry reloads into (F4-6)", () => {
  it("is announced and focused, once — and a later plain first paint is silent again", async () => {
    const reload = vi.fn();
    window.history.replaceState(null, "", "/wallet");
    retryByReload(reload);
    expect(reload).toHaveBeenCalledOnce();
    expect(isRetryLanding("/wallet")).toBe(true);

    const first = render(
      <MemoryRouter initialEntries={["/wallet"]}>
        <RouteAnnouncer />
        <Page title="Your wallet" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your wallet" })).toHaveFocus());
    expect(screen.getByTestId("route-announcer").textContent).toBe("Wallet");
    expect(isRetryLanding("/wallet"), "the mark is spent").toBe(false);
    first.unmount();
    (document.activeElement as HTMLElement | null)?.blur();

    render(
      <MemoryRouter initialEntries={["/wallet"]}>
        <RouteAnnouncer />
        <Page title="Your wallet" />
      </MemoryRouter>,
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.getByTestId("route-announcer").textContent).toBe("");
    expect(document.body).toHaveFocus();
  });

  it("ignores a mark left for a different page", () => {
    window.history.replaceState(null, "", "/bookings");
    retryByReload(() => {});
    render(
      <MemoryRouter initialEntries={["/wallet"]}>
        <RouteAnnouncer />
        <Page title="Your wallet" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("route-announcer").textContent).toBe("");
    sessionStorage.clear();
  });
});

describe("a fragment that names an accordion header", () => {
  it("focuses the header's button rather than the heading around it", () => {
    render(
      <section id="settings-doors">
        <h2><button type="button">Door gates</button></h2>
        <p>fields</p>
      </section>,
    );
    expect(focusFragmentTarget("#settings-doors")).toBe(true);
    expect(screen.getByRole("button", { name: "Door gates" })).toHaveFocus();
    expect(screen.getByRole("heading", { name: "Door gates" })).not.toHaveAttribute("tabindex");
  });

  it("still focuses a plain heading itself", () => {
    render(<section id="plain"><h2>Plain heading</h2></section>);
    expect(focusFragmentTarget("#plain")).toBe(true);
    const heading = screen.getByRole("heading", { name: "Plain heading" });
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute("tabindex", "-1");
  });
});

/**
 * D13 — after a keyboard sign-in the route announcer's focus on the page `h1` matched
 * `:focus-visible` (typing counts as keyboard modality) and drew a heavy box round "Your code".
 * What the app focuses FOR a person — a `tabindex="-1"` heading, landmark or panel — carries no
 * ring; a control parked at -1 (a menu item, a tab) keeps it.
 */
describe("the ring on programmatically focused elements (D13)", () => {
  const css = readFileSync(join(SRC, "index.css"), "utf8");
  const rule = /(\[tabindex="-1"\]:not\([^{]*\):focus)\s*\{\s*outline:\s*none;/.exec(css);

  it("has one rule that turns the outline off for a focused tabindex=-1 non-control", () => {
    expect(rule).not.toBeNull();
  });

  it("covers headings and landmarks, and spares controls that park at -1", () => {
    const selector = rule![1].replace(/:focus$/, "");
    const el = (html: string) => {
      const host = document.createElement("div");
      host.innerHTML = html;
      return host.firstElementChild as Element;
    };
    expect(el('<h1 tabindex="-1">Your code</h1>').matches(selector)).toBe(true);
    expect(el('<main tabindex="-1"></main>').matches(selector)).toBe(true);
    expect(el('<div role="region" tabindex="-1"></div>').matches(selector)).toBe(true);
    expect(el('<div role="menuitem" tabindex="-1"></div>').matches(selector)).toBe(false);
    expect(el('<button tabindex="-1"></button>').matches(selector)).toBe(false);
    expect(el('<button role="tab" tabindex="-1"></button>').matches(selector)).toBe(false);
    expect(el('<h1 tabindex="0">Not parked</h1>').matches(selector)).toBe(false);
  });
});


/**
 * X-9 (review round 3) — a DIRECT load of a record's page (an emailed deep link, a reload) kept
 * the generic title "Booking — Crusaders Squash": the first-paint branch returned before the
 * record was named, so only a navigation inside the app ever titled it. A first paint still says
 * nothing and moves nothing; it titles the tab once the heading names the record.
 */
describe("a record's page opened directly (X-9)", () => {
  it("titles the tab from a heading renamed in place, silently and without taking focus", async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    render(
      <MemoryRouter initialEntries={["/bookings/b-1"]}>
        <RouteAnnouncer />
        <Routes><Route path="/bookings/:bookingId" element={<SameHeadingRenamed />} /></Routes>
      </MemoryRouter>,
    );
    expect(document.title).toBe("Booking — Crusaders Squash");
    act(() => { screen.getByRole("button", { name: "finish reading" }).click(); });
    await waitFor(() => expect(document.title).toBe("Court 1 · Thu 1 Oct, 10:15 — Booking — Crusaders Squash"));
    expect(screen.getByTestId("route-announcer").textContent).toBe("");
    expect(screen.getByRole("heading", { name: "Court 1 · Thu 1 Oct, 10:15" })).not.toHaveFocus();
  });

  it("titles the tab from a heading that replaces the placeholder, and leaves focus where it was", async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    render(
      <MemoryRouter initialEntries={["/admin/members/u-1"]}>
        <RouteAnnouncer />
        <Routes><Route path="/admin/members/:userId" element={<LoadingThenNamed placeholder="Member" name="Thandi Probe" />} /></Routes>
      </MemoryRouter>,
    );
    const finish = screen.getByRole("button", { name: "finish reading" });
    act(() => { finish.click(); });
    await waitFor(() => expect(document.title).toBe("Thandi Probe — Member — Crusaders Squash"));
    expect(screen.getByTestId("route-announcer").textContent).toBe("");
    expect(screen.getByRole("heading", { name: "Thandi Probe" })).not.toHaveFocus();
  });

  it("titles a record whose heading is already named on the first paint", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/members/u-1"]}>
        <RouteAnnouncer />
        <Routes><Route path="/admin/members/:userId" element={<Page title="Thandi Probe" />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(document.title).toBe("Thandi Probe — Member — Crusaders Squash"));
    expect(screen.getByTestId("route-announcer").textContent).toBe("");
    expect(screen.getByRole("heading", { name: "Thandi Probe" })).not.toHaveFocus();
  });
});
