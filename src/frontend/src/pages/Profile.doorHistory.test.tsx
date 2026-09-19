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
  memberDoorsOnFixture,
  signIn,
  signOut,
  stubFetch,
  type StubRoute,
} from "../test/harness";
import { forgetLastKnown } from "../lib/lastKnown";

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
    expect(screen.getByText(/Your court hadn't opened the door yet/)).toBeInTheDocument();
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
});
