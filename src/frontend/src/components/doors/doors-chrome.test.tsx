import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
   * <b>First in the menu, above Devices.</b> Ordered by urgency of use rather than
   * alphabetically — Doors is opened standing in a club with a member waiting, Webhooks
   * twice a year.
   */
  it("is first in the menu, above Devices", async () => {
    chrome([doorFixture()]);

    fireEvent.click(await screen.findByRole("button", { name: /Open menu/ }));
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(items[0]).toContain("Doors");
    expect(items[1]).toContain("Devices");
  });

  /**
   * <b>A20, and the constraint it had to be measured against.</b>
   *
   * Nothing on an admin's landing screen said "Doors": a 6 px dot on a cog was the only cue,
   * and a volunteer never found the surface. The obvious fix — a sixth tab — is the one this
   * file's own nav comment warns about: five admin tabs already measured a 795 px
   * `scrollWidth` against a 768 px viewport, which is why the inline nav switches at `lg`
   * rather than `md`. So the tab exists, and `e2e/narrow-viewport.spec.ts` holds it to no
   * horizontal page scroll at every width it renders at. This test pins that the entry is
   * reachable from BOTH places rather than from the gear alone.
   */
  it("is reachable without opening the gear", async () => {
    chrome([doorFixture()]);

    const inNav = (await screen.findAllByRole("link", { name: /Doors/ }))
      .some((link) => link.getAttribute("href") === "/admin/doors");
    expect(inNav).toBe(true);
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
    // The gear carries the same sentence, so scope to the menu rather than the document.
    const badge = within(screen.getByRole("menu")).getByLabelText("1 door needs attention");
    expect(badge).toHaveTextContent("1");
  });

  /**
   * <b>A3 — the finding this cue was blind to.</b>
   *
   * A door flagged "Refusing a lot" or "May not be releasing" was never counted here, never
   * named in the doors page's banner, and — same predicate — sorted below the fold. A
   * reviewer found a front door turning away thirty scans in twenty minutes by scrolling
   * past three healthy ones. A2.6 keeps signals off admin HOME, which is a different screen
   * with a different reader; it never said anything about the gear that is the only route
   * to Doors.
   */
  it("counts a door that is turning people away", async () => {
    const whoami = signIn({ isAdmin: true });
    const server = doorsServer([doorFixture({ name: "Front door" })], {
      rows: {
        "99999999-9999-9999-9999-999999999999": {
          signals: [{ kind: "refusal_spike", since: ago(1200), until: ago(0), scans: 30 }],
        },
      },
    });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_credits: 120, entries: [], count: 0 } },
      { path: "/api/v1/me/profile", body: { user_id: whoami.user_id, email: "a@b.c", full_name: "Ada", photo_url: null, membership_number: "C-1" } },
      { path: "/api/v1/admin/members", body: [] },
      { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
      ...server.routes,
    ]);
    renderPage(<ProfileProvider><Layout /></ProfileProvider>, { initialEntries: ["/admin/settings"] });

    expect(await screen.findByRole("button", { name: "Open menu — 1 door needs attention" }))
      .toBeInTheDocument();
  });

  /**
   * A silent door outranks a signalling one: "has not been heard from" sends somebody to the
   * right board, and a cue that names the least urgent of two sends them to the wrong one.
   */
  it("names the silent door first when a door is also signalling", async () => {
    const whoami = signIn({ isAdmin: true });
    const server = doorsServer([
      doorFixture({ name: "Front door" }),
      doorFixture({ id: "99999999-9999-9999-9999-99999999aaaa", name: "Side door", gate_key: "side", last_seen_at: ago(3600) }),
    ], {
      rows: {
        "99999999-9999-9999-9999-999999999999": {
          signals: [{ kind: "refusal_spike", since: ago(1200), until: ago(0), scans: 30 }],
        },
      },
    });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_credits: 120, entries: [], count: 0 } },
      { path: "/api/v1/me/profile", body: { user_id: whoami.user_id, email: "a@b.c", full_name: "Ada", photo_url: null, membership_number: "C-1" } },
      { path: "/api/v1/admin/members", body: [] },
      { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
      ...server.routes,
    ]);
    renderPage(<ProfileProvider><Layout /></ProfileProvider>, { initialEntries: ["/admin/settings"] });

    expect(await screen.findByRole("button", { name: "Open menu — 2 doors need attention" }))
      .toBeInTheDocument();
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
    expect(banner).toHaveTextContent("1 of 1 door shut");
  });

  /**
   * <b>C2 — the sentence that was simply false.</b>
   *
   * It read "3 of 3 doors are shut. Members can't get in." whatever the doors were doing.
   * A shut door the club CANNOT reach has not heard the refusal: it goes on admitting
   * members with a booking from the list it last downloaded, for up to six hours. On the one
   * screen a volunteer trusts during an incident, the product asserted a lockdown it had not
   * achieved — P1 and P6 broken in eight words. The phrase is now banned outright, and the
   * banner states both halves and names the doors that have not confirmed.
   */
  it("never says members cannot get in, even with every door shut", async () => {
    chrome([doorFixture({ enabled: false, last_seen_at: ago(3600) })], "/admin/settings");

    const banner = await screen.findByRole("alert");
    expect(banner.textContent?.toLowerCase()).not.toContain("can't get in");
    expect(banner.textContent?.toLowerCase()).not.toContain("cannot get in");
  });

  it("says a shut door that is not reporting may still be admitting booked members", async () => {
    // `shut_by_shut_all_at` present ⇒ shut TOGETHER, which is the state the fleet banner is
    // about. A door shut on its own takes the other arm, two tests below.
    chrome([doorFixture({
      name: "Side door", enabled: false, last_seen_at: ago(3600),
      shut_by_shut_all_at: ago(120),
    })], "/admin/settings");

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("none of them confirmed yet");
    // Named, because "1 not yet" sends nobody anywhere.
    expect(banner).toHaveTextContent("Side door");
    expect(banner).toHaveTextContent("may still admit booked members");
  });

  /**
   * <b>C1 — a fleet Reopen that would reopen nothing is not offered at all.</b>
   *
   * `reopen-all` reopens only the doors a shut-all shut. With a door shut ON ITS OWN, the
   * banner used to offer "Reopen all doors", which answered `{"doors":[]}` and printed
   * "0 doors reopened" with no explanation.
   */
  it("offers no fleet reopen when the doors were shut one at a time, and links to each", async () => {
    chrome([doorFixture({ name: "Side door", enabled: false })], "/admin/settings");

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("one at a time");
    expect(banner).toHaveTextContent("would not touch these");
    expect(screen.queryByRole("link", { name: /Reopen the/ })).toBeNull();
    // The way back is the door's own page, which is never a dead link.
    expect(screen.getByRole("link", { name: "Side door" }))
      .toHaveAttribute("href", "/admin/doors/99999999-9999-9999-9999-999999999999");
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

  /**
   * <b>C8.</b> It was gated on the path starting `/admin/`, and an admin LANDS on
   * `/schedule`. A1.5 says every admin route; the reader is what makes a route an admin one,
   * not its URL.
   */
  it("follows the ADMIN rather than the route, so it shows on Bookings", async () => {
    chrome([doorFixture({ enabled: false })], "/schedule");

    expect(await screen.findByRole("alert")).toHaveTextContent("1 of 1 door shut");
  });

  it("stays away from a member entirely", async () => {
    const whoami = signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_credits: 120, entries: [], count: 0 } },
      { path: "/api/v1/me/profile", body: { user_id: whoami.user_id, email: "a@b.c", full_name: "Ada", photo_url: null, membership_number: "C-1" } },
    ]);
    renderPage(<ProfileProvider><Layout /></ProfileProvider>, { initialEntries: ["/schedule"] });

    await screen.findByRole("button", { name: /Open menu/ });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /**
   * <b>C17-21, found by looking at a rendered overview.</b> The banner's action linked to
   * `/admin/doors`, which is a dead control once you are already there — and the doors page
   * carries the real fleet control a few hundred pixels below it, so one screen offered the
   * same action twice, one of them inert. The sentence stays everywhere; the link stands
   * down where the page beneath it can do the job.
   */
  it("offers no link of its own on the page that carries the real control", async () => {
    chrome([doorFixture({ enabled: false, shut_by_shut_all_at: ago(120) })], "/admin/doors");

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("1 of 1 door shut");
    expect(within(banner).queryByRole("link")).toBeNull();
  });

  it("still offers it on an admin route that cannot reopen anything", async () => {
    chrome([doorFixture({ enabled: false, shut_by_shut_all_at: ago(120) })], "/admin/settings");

    const banner = await screen.findByRole("alert");
    expect(within(banner).getByRole("link", { name: "Reopen the door shut together" }))
      .toHaveAttribute("href", "/admin/doors");
  });

  /** B14 — it printed across the top of the door card that goes on a wall, Reopen and all. */
  it("is hidden from print", async () => {
    chrome([doorFixture({ enabled: false })], "/admin/settings");

    expect((await screen.findByRole("alert")).className).toContain("print:hidden");
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
    home([doorFixture({ name: "Side door", enabled: false, last_seen_at: ago(12) })]);

    expect(await screen.findByText("Side door is shut. Nobody gets in through it.")).toBeInTheDocument();
  });

  /**
   * C2's family. This fixture is a door that has NEVER called in — so "Nobody gets in
   * through it" is a claim about a machine the club has never heard from, which is exactly
   * the overstatement the banner was rewritten to stop making.
   */
  it("does not claim nobody gets in through a shut door it has never heard from", async () => {
    home([doorFixture({ name: "Side door", enabled: false, last_seen_at: null })]);

    expect(await screen.findByText(/Side door is shut, but nothing can reach it/))
      .toHaveTextContent("may not have been told");
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
