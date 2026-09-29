import { describe, expect, it, vi, afterEach } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ProfilePage from "./Profile";
import { AuthProvider } from "../lib/auth";
import { ProfileProvider } from "../lib/profile";
import { ToastProvider } from "../components/Toast";
import {
  memberDoorFixture,
  memberDoorHistoryRowFixture,
  memberDoorOfflineHistoryRowFixture,
  memberDoorsOnFixture,
  signIn,
  signOut,
  stubFetch,
  unreachable,
  type StubRoute,
} from "../test/harness";
import { forgetLastKnown } from "../lib/lastKnown";
import { myPlay } from "@/components/play/__tests__/playKit";

/**
 * "My door history" on /profile — W1.8.
 *
 * <p>
 * This card is the counterweight to the club's own door log. That log filters by DOOR,
 * TIME and OUTCOME and has no per-member filter anywhere in it, deliberately: the club's
 * log is about doors, and a member's own history belongs to the member. This is the
 * POPIA s.23 right served as a product feature rather than as an email somebody has to
 * answer by hand.
 * </p>
 *
 * <p>
 * The two things it must never become are asserted here as well as designed for: it may
 * not total anything — the moment it does it is entry statistics, and a door scan is
 * never attendance — and it may not offer a filter, a search or an export.
 * </p>
 */
describe("My door history", () => {
  afterEach(() => { vi.unstubAllGlobals(); signOut(); forgetLastKnown(); });

  const PROFILE = {
    user_id: "u1", email: "ada@club.test", is_admin: false, tenant_slug: "crusaders",
    full_name: "Ada Lovelace", membership_number: "MEM-1001", photo_url: null, status: "active",
  };

  function renderProfile(routes: StubRoute[]) {
    const whoami = signIn({ isAdmin: false });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/me/profile", body: PROFILE },
      { path: "/api/v1/me/webauthn/credentials", body: [] },
      { path: "/api/v1/me/preferences", body: { findable: false, show_in_leaderboards: false } },
      // P12 — My game is Profile's first section; answered, so its own retry is not on the page.
      { path: "/api/v1/me/play", body: myPlay() },
      ...routes,
    ]);
    return render(
      <MemoryRouter>
        <AuthProvider>
          <ProfileProvider>
            <ToastProvider><ProfilePage /></ToastProvider>
          </ProfileProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  }


  /**
   * The calls the stub has recorded, read back after `renderProfile` has installed it.
   *
   * <p>
   * `renderProfile` owns the stub and returns the render result rather than the stub, so
   * a test that wants to count requests reaches the mock through the global it replaced.
   * Cheaper than changing a helper eight tests already depend on.
   * </p>
   */
  function stubFetchForRefresh(): () => { path: string }[] {
    return () => (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls
      .map(([input]) => ({ path: String(input) }));
  }

  const HISTORY = (over: Record<string, unknown> = {}) => ({
    items: [memberDoorHistoryRowFixture()],
    next_cursor: null,
    retention_days: 90,
    // WIRE-R2 §4 — the club's own zone, on the same read as the rows.
    timezone: "Africa/Johannesburg",
    ...over,
  });

  /**
   * A member of a club that has never owned a door has no door history, and must not be
   * told they have none: the card does not render at all.
   */
  it("does not exist at a club with no door", async () => {
    renderProfile([{ path: "/api/v1/me/door", body: memberDoorFixture() }]);

    await screen.findByLabelText("Full name");
    await waitFor(() => expect(screen.getByText("Passkeys")).toBeInTheDocument());
    expect(screen.queryByText("My door history")).toBeNull();
  });

  it("exists at a doors club, with the anchor a data request can be pointed at", async () => {
    const { container } = renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY() },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    expect(await screen.findByText("My door history")).toBeInTheDocument();
    expect(container.querySelector("#door-history")).not.toBeNull();
  });

  /**
   * P2, stated rather than implied by the chips. Without it "Lock released" is read as
   * "the door opened and somebody went through it", which is a claim about a hinge that
   * nothing in this system has ever observed.
   */
  it("says there is no sensor, and that nothing here says the door was pushed", async () => {
    renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY() },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    const notice = await screen.findByText(/released the lock/);
    expect(notice).toHaveTextContent(/no sensor/i);
    expect(notice).toHaveTextContent(/nothing here says the door was pushed/i);
    expect(notice.textContent).not.toMatch(/walked in|went in|entered the building/i);
  });

  /** P3, said out loud: the club's own log cannot be filtered to a person. */
  it("says the club's own door log cannot be filtered to a person", async () => {
    renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY() },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    const intro = await screen.findByText(/Only yours/);
    expect(intro).toHaveTextContent(/can't be filtered to a person/);
  });

  it("gives every row a date, a time, a door and an outcome in words", async () => {
    renderProfile([
      {
        path: "/api/v1/me/door/history",
        body: HISTORY({
          items: [
            memberDoorHistoryRowFixture(),
            memberDoorHistoryRowFixture({ at: "2026-09-19T06:03:00Z", released: false, reason: "too_early" }),
          ],
        }),
      },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    // The CARD appears before its rows do — it renders its own loading state first — so
    // waiting for the heading and then reading synchronously is a race, and it lost one.
    expect(await screen.findByText("Lock released")).toBeInTheDocument();
    expect(screen.getAllByText(/front-door/).length).toBe(2);
    expect(screen.getByText("Too early")).toBeInTheDocument();
    // D2 — the row cannot know WHICH of the member's two codes was held up, so it may not
    // say "your court". A member with no court booked at all read seventeen of these, all
    // of them refusals of a booking code for the following day.
    expect(screen.getByText(/The booking that code belonged to hadn't opened the door yet/))
      .toBeInTheDocument();
    // A date as well as a clock time: two rows an hour apart on different days are
    // otherwise indistinguishable.
    expect(screen.getAllByText(/\d{2}:\d{2}$/).length).toBeGreaterThanOrEqual(2);
  });

  /** A1.2: an open reads "Lock released" in a feed, never "Opened". */
  it("never labels an open as a door that opened", async () => {
    renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY() },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    await screen.findByText("Lock released");
    expect(screen.queryByText("Opened")).toBeNull();
  });

  /**
   * A row the endpoint returns with no reason on it at all.
   *
   * <p>
   * `DoorActivityView.Details` swallows a `JsonException` and answers null, and `Reason`
   * then finds neither a `reason` nor an `outcome` to read — so a refusal whose details
   * were written malformed arrives here with `reason: null`. The row is still the member's
   * own evidence that a code of theirs was turned away; dropping it, or rendering the word
   * "null" into the chip, are the two wrong answers.
   * </p>
   */
  it("still shows a row the server could not say a reason for", async () => {
    renderProfile([
      {
        path: "/api/v1/me/door/history",
        body: HISTORY({ items: [memberDoorHistoryRowFixture({ released: false, reason: null })] }),
      },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    expect(await screen.findByText("Turned away")).toBeInTheDocument();
    expect(screen.getByText(/front-door/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bnull\b|\bundefined\b/);
  });

  it("says an offline row was decided from the door's own downloaded list", async () => {
    renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY({ items: [memberDoorHistoryRowFixture({ offline: true })] }) },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    expect(await screen.findByText(/From the door's own list/)).toBeInTheDocument();
  });

  it("states the retention the server gave it, and never invents one", async () => {
    renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY({ retention_days: 45 }) },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    expect(await screen.findByText(/keeps these for 45 days/)).toBeInTheDocument();
  });

  it("says the club has not set a retention rather than showing a made-up number", async () => {
    renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY({ retention_days: 0 }) },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    const line = await screen.findByText(/hasn't set how long it keeps these/);
    expect(line.textContent).not.toMatch(/\b90\b/);
  });

  // --- three states, three different sentences --------------------------------------

  /**
   * The defect this pair exists to make impossible: a list initialised to `[]` renders
   * its empty state on a FAILED read, and the member concludes nothing has ever been
   * recorded about them.
   */
  it("says an empty record is a real answer, not a failed read", async () => {
    renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY({ items: [] }) },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    const empty = await screen.findByText(/Nothing has been recorded against your codes/);
    expect(empty).toHaveTextContent(/real answer/);
    expect(empty).toHaveTextContent(/not a failed read/);
  });

  it("says a failed read does not mean there is nothing there, in different words", async () => {
    renderProfile([
      { path: "/api/v1/me/door/history", status: 500, body: { error: "boom" } },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    const failed = await screen.findByText(/Couldn't load your door history/);
    expect(failed).toHaveTextContent(/doesn't mean there's nothing there/);
    expect(screen.queryByText(/Nothing has been recorded against your codes/)).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  // --- paging -------------------------------------------------------------------------

  it("fetches the next page on Show more, and asks for it by cursor", async () => {
    const whoami = signIn({ isAdmin: false });
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/me/profile", body: PROFILE },
      { path: "/api/v1/me/webauthn/credentials", body: [] },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
      { path: "/api/v1/me/preferences", body: { findable: false, show_in_leaderboards: false } },
      {
        path: "/api/v1/me/door/history",
        body: {},
        sequence: [
          HISTORY({ items: [memberDoorHistoryRowFixture()], next_cursor: "page-2" }),
          HISTORY({ items: [memberDoorHistoryRowFixture({ at: "2026-09-18T19:12:00Z", door_name: "side-door" })] }),
        ],
      },
    ]);
    render(
      <MemoryRouter>
        <AuthProvider>
          <ProfileProvider>
            <ToastProvider><ProfilePage /></ToastProvider>
          </ProfileProvider>
        </AuthProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));

    expect(await screen.findByText("side-door")).toBeInTheDocument();
    // Asked for BY CURSOR, not by offset — and the cursor is the one the server gave.
    expect(stub.calls.some((c) => c.path.includes("/me/door/history?cursor=page-2"))).toBe(true);
    // The rows already on screen are APPENDED to, never replaced.
    expect(screen.getAllByText(/front-door/).length).toBe(1);
    // And the control is gone, because the server said there is no next page.
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  /** A Show more that fails must leave what the member is already reading on screen. */
  it("keeps the rows it has when Show more fails", async () => {
    renderProfile([
      {
        path: "/api/v1/me/door/history",
        body: {},
        status: [200, 500],
        sequence: [HISTORY({ next_cursor: "page-2" }), { error: "boom" }],
      },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));

    expect(await screen.findByText(/Couldn't load any more/)).toBeInTheDocument();
    expect(screen.getByText("Lock released")).toBeInTheDocument();
    // And it is NOT the whole-card failure sentence, which would read as "your record is
    // gone" over a screen still showing it.
    expect(screen.queryByText(/Couldn't load your door history/)).toBeNull();
  });

  // --- what this card may never become --------------------------------------------------

  /**
   * No filter, no search, no export, and above all no total. The moment this card counts
   * anything it has become entry statistics, and the spec anticipates that pressure by
   * name and refuses it.
   */
  it("offers nothing that would turn a member's own record into statistics", async () => {
    const { container } = renderProfile([
      {
        path: "/api/v1/me/door/history",
        body: HISTORY({
          items: [memberDoorHistoryRowFixture(), memberDoorHistoryRowFixture({ at: "2026-09-18T19:12:00Z" })],
        }),
      },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    const card = (await screen.findByText("My door history")).closest("div");
    expect(card?.textContent).not.toMatch(/\b(filter|search|export|download|total|times this month|streak)\b/i);
    // No text input inside the card at all — a search box is the first step of every one
    // of the above.
    expect(container.querySelector("#door-history input")).toBeNull();
  });

  // --- D14: a record with no date on it is one nobody can trust twice ---------------------

  /**
   * This card is read on mount and never polled, deliberately: a member scanning back
   * through their own record should control every fetch. The cost of that decision is a
   * page that can sit open for an hour showing rows from an hour ago with nothing on it
   * to say so, and nothing short of a full reload to ask again. Both halves were missing.
   */
  it("says when the rows on screen were read", async () => {
    renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY() },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    expect(await screen.findByText(/^As of \d{2}:\d{2}\./)).toBeInTheDocument();
  });

  it("lets the member ask again without reloading the page", async () => {
    const stub = stubFetchForRefresh();
    renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY() },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);
    await screen.findByText("My door history");

    const before = stub().filter((c) => c.path.startsWith("/api/v1/me/door/history")).length;
    fireEvent.click(await screen.findByRole("button", { name: /Refresh/ }));

    await waitFor(() => {
      expect(stub().filter((c) => c.path.startsWith("/api/v1/me/door/history")).length).toBeGreaterThan(before);
    });
  });

  /**
   * Refresh REPLACES, where Show more appends. A refresh that appended would double every
   * row on screen — a member's own record apparently recording the same scan twice, which
   * on this card of all cards is the worst possible way to be wrong.
   */
  it("replaces the rows on a refresh rather than appending them", async () => {
    renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY() },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);
    await screen.findByText("My door history");
    const rows = () => [...document.querySelectorAll("#door-history li")].length;
    await waitFor(() => expect(rows()).toBe(1));

    const stub = stubFetchForRefresh();
    const before = stub().filter((c) => c.path.startsWith("/api/v1/me/door/history")).length;
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));

    // WAIT for the refresh to land before counting. A `waitFor` on "still one row" is
    // satisfied by its first reading, which happens before the response has been applied
    // — so it passes over an implementation that appends, which is what a mutation pass
    // found. The request count is what says the answer has actually arrived.
    await waitFor(() => {
      expect(stub().filter((c) => c.path.startsWith("/api/v1/me/door/history")).length).toBeGreaterThan(before);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /Refresh/ })).toBeEnabled());
    expect(rows()).toBe(1);
  });

  // --- D7: a member never reads about a door the club has not named ----------------------

  /**
   * The contradiction the reviewer photographed: six offline releases listed against "a
   * door the club hasn't named yet", directly above a disclosure saying such a door
   * "opens nothing while it is cut off". The name was being stripped from offline rows on
   * the way out — the backend lane is fixing that — and the phrase itself is an admin fact
   * a member cannot act on either way.
   */
  it("calls a row with no door name a club door", async () => {
    renderProfile([
      {
        path: "/api/v1/me/door/history",
        body: HISTORY({ items: [memberDoorHistoryRowFixture({ door_name: null, offline: true })] }),
      },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    expect(await screen.findByText("a club door")).toBeInTheDocument();
    expect(screen.queryByText(/hasn't named/i)).toBeNull();
  });

  // --- WIRE-R1 §2 / §8: the list is ordered on DELIVERY, not on the scan ------------------

  /**
   * A door cut off for an hour hands the club an hour of scans at once, and the list is
   * ordered and paged on that axis — so those rows land together and their own times run
   * backwards against the rows around them. Unexplained, a member reads their own record
   * as wrong, which on the one screen that exists for them to check what happened is the
   * worst thing it could be.
   */
  it("says when the club heard, and why a row can sit out of order", async () => {
    renderProfile([
      {
        path: "/api/v1/me/door/history",
        body: HISTORY({
          items: [
            memberDoorHistoryRowFixture({ at: "2026-09-19T06:20:00Z" }),
            memberDoorOfflineHistoryRowFixture({ at: "2026-09-19T05:40:00Z" }),
          ],
        }),
      },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    expect(await screen.findByText(/The club heard at \d{2}:\d{2}\./)).toBeInTheDocument();
    expect(screen.getByText(/listed by when the club heard about them/)).toBeInTheDocument();
  });

  /**
   * And neither sentence appears when nothing on screen took that journey. A note about
   * out-of-order rows, on a list that has none, is the page explaining a mechanism instead
   * of answering a question.
   */
  it("explains nothing about delivery when every row was decided with the club", async () => {
    renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY() },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    await screen.findByText("My door history");
    expect(screen.queryByText(/The club heard at/)).toBeNull();
    expect(screen.queryByText(/listed by when the club heard about them/)).toBeNull();
  });

  /**
   * WIRE-R1 §8: a malformed cursor is a 400 `cursor_invalid` rather than a silent full
   * result. The page cannot send one — the cursor comes from the previous response — but
   * a 400 on Show more must still leave the rows that are already on screen, because
   * replacing them with an error is the member losing their record over a paging fault.
   */
  it("keeps the rows it has when the club refuses the cursor", async () => {
    renderProfile([
      {
        method: "GET", path: "/api/v1/me/door/history", status: [200, 400], body: null,
        sequence: [HISTORY({ next_cursor: "c2" }), { error: "cursor_invalid" }],
      },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);
    await screen.findByText("My door history");

    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));

    expect(await screen.findByText(/Couldn't load any more/)).toBeInTheDocument();
    // The record itself survives. The failed read is a sentence beside it, not instead of it.
    expect([...document.querySelectorAll("#door-history li")].length).toBe(1);
  });

  // --- D11: this card belongs to its OWN read ----------------------------------------

  /**
   * <b>A `/me/door` that failed used to delete the member's whole record from their own
   * page.</b> The flag that gates this card answered `false` on any error, so one unlucky
   * request — a dropped connection, a 500, a gateway restart — read as "this club has no
   * doors", and a member whose history endpoint was answering perfectly and had rows in it
   * was shown nothing at all. The two reads are independent and this card is gated on what
   * it can see for itself.
   */
  it("shows the member's rows even when the door read fails", async () => {
    renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY() },
      unreachable("/api/v1/me/door"),
    ]);

    expect(await screen.findByText("My door history")).toBeInTheDocument();
    expect(await screen.findByText("Lock released")).toBeInTheDocument();
  });

  /**
   * And the other half of the same rule, which is why it is not simply "always render".
   * With the door question unanswered AND nothing of the member's own to show, the card
   * says nothing — a member of a club that has never owned a door must not be told they
   * have no door history.
   */
  it("stays silent when the door read fails and the member has no rows", async () => {
    renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY({ items: [] }) },
      unreachable("/api/v1/me/door"),
    ]);

    await screen.findByLabelText("Full name");
    await waitFor(() => expect(screen.getByText("Passkeys")).toBeInTheDocument());
    expect(screen.queryByText("My door history")).toBeNull();
  });

  // --- D9 / C15: landing on the section, and what a screen reader hears ---------------

  /**
   * D9. `/profile#door-history` scrolled, and the browser's own anchor jump put the heading
   * at y = −29 on one viewport and y = −335 on another — because the card mounts and then
   * grows by several hundred pixels as its rows arrive underneath the jump. So the scroll
   * happens once the rows are in, and it moves FOCUS as well as the viewport: without that
   * a screen-reader user who followed the link is still at the top of the page with no idea
   * anything happened.
   */
  it("focuses the section heading when the page is opened at its anchor", async () => {
    window.history.replaceState(null, "", `/profile#door-history`);
    try {
      renderProfile([
        { path: "/api/v1/me/door/history", body: HISTORY() },
        { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
      ]);

      const heading = await screen.findByText("My door history");
      await waitFor(() => expect(document.activeElement).toBe(heading));
      // In the tab order only as a target: a heading that takes a Tab stop of its own is a
      // stop every keyboard user pays for on every visit.
      expect(heading.getAttribute("tabindex")).toBe("-1");
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("does not steal focus when the page was not opened at its anchor", async () => {
    renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY() },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    const heading = await screen.findByText("My door history");
    await screen.findByText("Lock released");
    expect(document.activeElement).not.toBe(heading);
  });

  /** C15 — a named region, so it can be found in a landmark list and announced on arrival. */
  it("is a named region", async () => {
    renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY() },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    const region = await screen.findByRole("region", { name: "My door history" });
    expect(region.id).toBe("door-history");
  });

  /**
   * C15's other half, and the one a sighted reader never sees. The permanent explanation of
   * what "Lock released" means sat in `role="status"` — a LIVE region — so a screen reader
   * announced the whole paragraph as an update every time the section rendered, including
   * on arrival from the `/my-code` link. A live region is for something that has just
   * changed; a sentence that has been true since the card was written is not that.
   */
  it("keeps its permanent explanation out of a live region", async () => {
    renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY() },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    const notice = await screen.findByText(/There's no sensor on the door/);
    expect(notice.getAttribute("role")).toBeNull();
    expect(notice.getAttribute("aria-live")).toBeNull();
    expect(notice.closest("[role=status],[aria-live]")).toBeNull();
  });

  // --- O1 and the LOW list ------------------------------------------------------------

  /**
   * Every face in this list is the CLUB's day, off the `timezone` the same read carries
   * (WIRE-R2 §4) — which is the right choice and an invisible one for a member reading
   * their record from anywhere else. One line under the list removes the whole question.
   */
  it("writes every row in the club's own day, and says so once", async () => {
    renderProfile([
      // Two hours behind the club, so a row written in the viewer's zone would read 08:04
      // where the club's own log reads 06:04. The runner is pinned to the club's zone, so
      // this is the only way the difference is visible at all.
      { path: "/api/v1/me/door/history", body: HISTORY({ timezone: "Europe/London" }) },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    await screen.findByText("Lock released");
    // 06:04Z is 08:04 in Johannesburg and 07:04 in London.
    expect(screen.getByText(/07:04$/)).toBeInTheDocument();
    expect(screen.queryByText(/08:04$/)).toBeNull();
    expect(screen.getByText("Times are the club's own.")).toBeInTheDocument();
  });

  // --- R3-31: six rows identical in every visible field ------------------------------

  /**
   * <b>A scanner held against a code fires repeatedly, and every attempt is a row.</b> The
   * reviewer's own record showed six of them — same door, same minute, same outcome, same
   * sentence — which is a record nobody can read and, worse, one a member counts and
   * concludes six separate things happened to them.
   *
   * <p>
   * The collapse is on what the row DRAWS, not on what it is, so it can never hide a
   * difference the member can see. And the marker is a de-duplication count, not a total:
   * the card's own rule is that the moment it totals anything it has become entry
   * statistics, which is asserted separately below and still holds.
   * </p>
   */
  it("says six identical rows once, with a count and the span they fell in", async () => {
    const burst = [0, 1, 2, 3, 4, 5].map((i) => memberDoorHistoryRowFixture({
      at: `2026-09-19T06:04:0${i}Z`, released: false, reason: "not_recognised",
    }));
    renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY({ items: burst }) },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    await screen.findByText("Code not recognised");
    expect(screen.getAllByText("Code not recognised")).toHaveLength(1);
    expect(screen.getByText(/×6 within 5 seconds/)).toBeInTheDocument();
  });

  /** Rows that differ in anything a member can see are two rows, however close together. */
  it("never collapses rows that do not look the same", async () => {
    renderProfile([
      {
        path: "/api/v1/me/door/history",
        body: HISTORY({ items: [
          memberDoorHistoryRowFixture({ at: "2026-09-19T06:04:00Z", released: false, reason: "too_early" }),
          memberDoorHistoryRowFixture({ at: "2026-09-19T06:04:01Z", released: false, reason: "not_recognised" }),
        ] }),
      },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    await screen.findByText("Too early");
    expect(screen.getByText("Code not recognised")).toBeInTheDocument();
    expect(screen.queryByText(/×\d/)).toBeNull();
  });

  // --- R3-17: a time the door's own clock could not vouch for -------------------------

  /**
   * <b>"the door told us at 19:22" about a 19:48 scan.</b> A board has no real-time clock;
   * it takes the time from the club and guesses while it is cut off, so a delivery instant
   * earlier than the scan it reports is the clock being wrong rather than a journey that
   * finished before it started. Printing it hands a member two numbers that cannot both be
   * right, on the one screen that exists to let them check what happened.
   */
  it("withholds an impossible delivery order and calls the minute approximate", async () => {
    renderProfile([
      {
        path: "/api/v1/me/door/history",
        body: HISTORY({ items: [memberDoorOfflineHistoryRowFixture({
          at: "2026-09-19T17:48:00Z", delivered_at: "2026-09-19T17:22:00Z",
        })] }),
      },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    await screen.findByText(/From the door's own list/);
    expect(screen.queryByText(/The club heard at/)).toBeNull();
    expect(screen.getByText(/The door's clock was out/)).toBeInTheDocument();
  });

  /** The server's own flag is honoured too — it knows about a clamp this screen cannot see. */
  it("honours the server's own time_uncertain flag", async () => {
    renderProfile([
      {
        path: "/api/v1/me/door/history",
        body: HISTORY({ items: [memberDoorHistoryRowFixture({ time_uncertain: true })] }),
      },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    await screen.findByText("Lock released");
    expect(screen.getByText(/The door's clock was out/)).toBeInTheDocument();
  });

  /** And an ordinary row says nothing of the kind. A warning on every row is no warning. */
  it("says nothing about a clock that was fine", async () => {
    renderProfile([
      { path: "/api/v1/me/door/history", body: HISTORY({ items: [memberDoorOfflineHistoryRowFixture()] }) },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture() },
    ]);

    await screen.findByText(/The club heard at 08:09/);
    expect(screen.queryByText(/The door's clock was out/)).toBeNull();
  });
});
