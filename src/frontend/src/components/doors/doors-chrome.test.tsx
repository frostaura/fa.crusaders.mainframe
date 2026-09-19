import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import Layout from "../Layout";
import HomePage from "../../pages/Home";
import { ProfileProvider } from "../../lib/profile";
import { SETTINGS_FIXTURE, doorFixture, doorsServer, renderPage, signIn, signOut, stubFetch } from "../../test/harness";

/**
 * What the doors surface puts into the app chrome, and onto Home.
 *
 * <p>
 * Three cues, all on one read, all on the `usePendingApplicationCount` posture this product
 * already has: a dot on the gear, a count on the Doors menu item, and the club-wide shut
 * banner. That hook's own comment carries the rule these are held to — <i>a badge is a cue,
 * not a screen: a failed read shows nothing rather than an error</i> — which is also what
 * makes the banner safe: its ABSENCE is the default, so a failed read has never meant "no
 * doors are shut".
 * </p>
 */

afterEach(() => signOut());

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

function chrome(doors: Record<string, unknown>[], route = "/admin/settings") {
  const whoami = signIn({ isAdmin: true });
  const server = doorsServer(doors);
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", body: { balance_credits: 120, entries: [], count: 0 } },
    { path: "/api/v1/me/profile", body: { user_id: whoami.user_id, email: "a@b.c", full_name: "Ada", photo_url: null, membership_number: "C-1" } },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
    ...server.routes,
  ]);
  return renderPage(<ProfileProvider><Layout /></ProfileProvider>, { initialEntries: [route] });
}

function chromeWithFailedDoors(route = "/admin/settings") {
  const whoami = signIn({ isAdmin: true });
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", body: { balance_credits: 120, entries: [], count: 0 } },
    { path: "/api/v1/me/profile", body: { user_id: whoami.user_id, email: "a@b.c", full_name: "Ada", photo_url: null, membership_number: "C-1" } },
    { path: "/api/v1/admin/members", body: [] },
    { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
    { path: "/api/v1/admin/doors", status: 503, body: {} },
  ]);
  return renderPage(<ProfileProvider><Layout /></ProfileProvider>, { initialEntries: [route] });
}

describe("the Doors entry in the gear menu", () => {
  /**
   * <b>The gear, not a sixth tab.</b> `Layout.tsx` already carries the cost of the
   * alternative in its own nav comment: five admin tabs measured a 795 px scrollWidth
   * against a 768 px viewport, which is why the inline nav switches at `lg` rather than
   * `md`. A sixth tab re-buys that defect.
   */
  it("is first in the menu, above Devices, and adds no tab", async () => {
    chrome([doorFixture()]);

    fireEvent.click(await screen.findByRole("button", { name: /Open menu/ }));
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(items[0]).toContain("Doors");
    expect(items[1]).toContain("Devices");
    // The tab strips, inline and scrolling, are unchanged.
    for (const nav of screen.getAllByRole("navigation")) {
      expect(nav.textContent).not.toContain("Doors");
    }
  });

  /**
   * <b>The count goes in the NAME.</b> A number inside a 44 px circular icon button is
   * unreadable at 360 and a dot is not — and colour alone is never the signal, so the dot
   * is decorative and the sentence is the accessible name.
   */
  it("names how many doors need attention on the gear, and dots it", async () => {
    chrome([doorFixture({ last_seen_at: ago(3600) })]);

    expect(await screen.findByRole("button", { name: "Open menu — 1 door needs attention" }))
      .toBeInTheDocument();
  });

  it("pluralises the gear's name for more than one", async () => {
    chrome([
      doorFixture({ last_seen_at: ago(3600) }),
      doorFixture({ id: "99999999-9999-9999-9999-99999999aaaa", name: "Front door", gate_key: null }),
    ]);

    expect(await screen.findByRole("button", { name: "Open menu — 2 doors need attention" }))
      .toBeInTheDocument();
  });

  it("puts the same sentence on the menu item's badge", async () => {
    chrome([doorFixture({ last_seen_at: ago(3600) })]);

    fireEvent.click(await screen.findByRole("button", { name: /Open menu/ }));
    expect(screen.getByLabelText("1 door needs attention")).toHaveTextContent("1");
  });

  /** Counted: silent, shut, unnamed. Not counted: a door that is simply reporting. */
  it("says nothing at all when every door is reporting, named and open", async () => {
    chrome([doorFixture()]);

    const gear = await screen.findByRole("button", { name: "Open menu" });
    fireEvent.click(gear);
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    expect(screen.queryByLabelText(/needs attention/)).toBeNull();
  });

  /** A cue, not a screen: a failed read shows nothing rather than an error. */
  it("renders no dot and no error when the doors read fails", async () => {
    chromeWithFailedDoors();

    expect(await screen.findByRole("button", { name: "Open menu" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/needs attention/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the club-wide shut banner", () => {
  /**
   * <b>A1.5 / D5.</b> Shut-all has no timed auto-reopen, so without this a club that shut
   * every door after an incident finds out at 05:50 the next morning with thirty members
   * outside. It is on every admin route, not only the doors pages.
   */
  it("is on an admin route that has nothing to do with doors", async () => {
    chrome([doorFixture({ enabled: false })], "/admin/settings");

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("1 of 1 door is shut.");
    expect(banner).toHaveTextContent("Members can't get in.");
  });

  /** The second sentence is true only when EVERY door is shut, so it appears only then. */
  it("does not claim members cannot get in while one door is open", async () => {
    chrome([
      doorFixture({ enabled: false }),
      doorFixture({ id: "99999999-9999-9999-9999-99999999aaaa", name: "Front door", gate_key: "front-door" }),
    ]);

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("1 of 2 doors is shut.");
    expect(banner).not.toHaveTextContent("Members can't get in");
  });

  /**
   * It LINKS rather than reopening: a reopen has to show its own per-door result — which
   * doors confirmed and which may still be admitting booked members — and a one-line banner
   * is not where a result belongs.
   */
  it("links to Doors rather than reopening from the banner", async () => {
    chrome([doorFixture({ enabled: false })]);

    expect(await screen.findByRole("link", { name: "Reopen all doors" }))
      .toHaveAttribute("href", "/admin/doors");
  });

  it("is absent while every door is open", async () => {
    chrome([doorFixture()]);

    await screen.findByRole("button", { name: "Open menu" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /** Its absence is its default, so a failed read cannot produce a false all-clear. */
  it("renders nothing when the doors read fails, and reports no failure of its own", async () => {
    chromeWithFailedDoors();

    await screen.findByRole("button", { name: "Open menu" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stays off a member route", async () => {
    chrome([doorFixture({ enabled: false })], "/schedule");

    await screen.findByRole("button", { name: /Open menu/ });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the admin Home row", () => {
  function home(doors: Record<string, unknown>[]) {
    const whoami = signIn({ isAdmin: true });
    const server = doorsServer(doors);
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_credits: 120, entries: [], count: 0 } },
      ...server.routes,
    ]);
    return renderPage(<HomePage />, { initialEntries: ["/"] });
  }

  /**
   * <b>On a normal day Home says nothing at all about doors.</b> P7 is a rule about email and
   * it is the right rule for a home screen too: a panel that is always there is one an admin
   * skims past, so it is worth nothing on the morning it matters — and "all 3 doors
   * reporting" would be a standing claim of exactly the kind the chip refuses to make.
   */
  it("is absent when every door is reporting, named and open", async () => {
    home([doorFixture()]);

    await screen.findByText("Book a court");
    expect(screen.queryByText("Admin · Doors")).toBeNull();
  });

  it("names the door and what is wrong with it when one is silent", async () => {
    home([doorFixture({ name: "Side door", last_seen_at: ago(3600) })]);

    expect(await screen.findByText("Admin · Doors")).toBeInTheDocument();
    expect(screen.getByText("Side door has not been heard from.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Admin · Doors/ })).toHaveAttribute("href", "/admin/doors");
  });

  it("says a shut door is shut rather than that it has gone quiet", async () => {
    home([doorFixture({ name: "Side door", enabled: false, last_seen_at: null })]);

    expect(await screen.findByText("Side door is shut. Nobody gets in through it.")).toBeInTheDocument();
  });

  it("names one door and counts the others", async () => {
    home([
      doorFixture({ name: "Side door", last_seen_at: ago(3600) }),
      doorFixture({ id: "99999999-9999-9999-9999-99999999aaaa", name: "Front door", gate_key: null }),
      doorFixture({ id: "99999999-9999-9999-9999-99999999bbbb", name: "Back door", gate_key: "back", enabled: false }),
    ]);

    expect(await screen.findByText(/Side door has not been heard from\. 2 other doors need attention\./))
      .toBeInTheDocument();
  });

  /** Never for a signal or a count — those are operational detail, and belong on the door. */
  it("says nothing about a refusal spike", async () => {
    const whoami = signIn({ isAdmin: true });
    const server = doorsServer([doorFixture()], {
      rows: { "99999999-9999-9999-9999-999999999999": { signals: [{ kind: "refusal_spike", since: ago(1200), until: ago(0), scans: 11 }] } },
    });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_credits: 120, entries: [], count: 0 } },
      ...server.routes,
    ]);
    renderPage(<HomePage />, { initialEntries: ["/"] });

    await screen.findByText("Book a court");
    expect(screen.queryByText("Admin · Doors")).toBeNull();
    expect(document.body.textContent).not.toContain("Refusing a lot");
  });

  it("renders no row when the doors read fails", async () => {
    const whoami = signIn({ isAdmin: true });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_credits: 120, entries: [], count: 0 } },
      { path: "/api/v1/admin/doors", status: 503, body: {} },
    ]);
    renderPage(<HomePage />, { initialEntries: ["/"] });

    await screen.findByText("Book a court");
    expect(screen.queryByText("Admin · Doors")).toBeNull();
  });
});
