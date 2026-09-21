import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import MyCodePage from "../../pages/MyCode";
import { memberDoorBookingFixture, memberDoorsOnFixture, renderPage, stubFetch } from "../../test/harness";
import { forgetLastKnown, rememberWalkUpChoice, WALK_UP_KEY } from "../../lib/lastKnown";
import { USE_MEMBER_CODE_INSTEAD } from "../../lib/memberDoorCopy";

/**
 * Item 9 — the code switch as a capsule tab control.
 *
 * <p>
 * <b>The contradiction this replaces.</b> The card headline read "Walk-up code · any court"
 * while the switch labelled "Walk up / pay for someone" was <i>unchecked</i> — reproduced on
 * two accounts, and it is the commonest state there is: a member with no booking, having
 * chosen nothing, gets an ident code because the server picks one. `describeKind` rendered
 * off `qr.kind`; the switch rendered off a separate `walkUp` boolean. Two sources of truth
 * for one fact.
 * </p>
 *
 * <p>
 * The selected segment is now DERIVED from the code on the glass, which is what makes the
 * disagreement unrepresentable rather than merely fixed. The member's preference still
 * exists — it is the argument to the next fetch, not the state of the control.
 * </p>
 */

const BOOKING = {
  code: "7K3M9XQ2RD5A", kind: "booking", expires_in_seconds: 900, court_number: 3,
  starts_at: "2099-01-01T17:00:00Z", doors: true,
};
const IDENT = { code: "ZZ9P4T6WQ8HN", kind: "ident", expires_in_seconds: 60, doors: true };
const EMPTY_HISTORY = { items: [], has_more: false };

/** Answers `kind=ident` with the ident code and everything else with whatever `pick` says. */
function serve(pick: Record<string, unknown>, door = memberDoorsOnFixture()) {
  return stubFetch([
    {
      method: "POST", path: "/api/v1/me/qr/generate",
      respond: (req) => (req.path.includes("kind=ident") ? IDENT : pick),
    },
    { path: "/api/v1/me/door", body: door },
    { path: "/api/v1/me/door/history", body: EMPTY_HISTORY },
  ]);
}

const codeRequests = (stub: { calls: { method: string; path: string }[] }) =>
  stub.calls.filter((c) => c.method === "POST" && c.path.startsWith("/api/v1/me/qr/generate"));

describe("the code tabs", () => {
  afterEach(() => { vi.unstubAllGlobals(); forgetLastKnown(); });

  it("names the group rather than the widget, and offers exactly two segments", async () => {
    serve(IDENT);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    expect(screen.getByRole("tablist", { name: "Which code to show" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Booking code", "Member code"]);
  });

  /**
   * D4 bug 5(a), as a rule rather than as a sentence. The stored preference says nothing
   * about which code arrived; only the payload does.
   */
  it("derives the selected segment from the code on screen, never from the stored choice", async () => {
    // The member asked for their member code, and the server nonetheless answered `booking`
    // — which it may: `kind` is a request, not a contract. The tab follows the CODE.
    rememberWalkUpChoice(true);
    stubFetch([
      { method: "POST", path: "/api/v1/me/qr/generate", body: BOOKING },
      { path: "/api/v1/me/door", body: memberDoorsOnFixture({ next_booking: memberDoorBookingFixture() }) },
      { path: "/api/v1/me/door/history", body: EMPTY_HISTORY },
    ]);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    expect(screen.getByRole("tab", { name: "Booking code" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Member code" })).toHaveAttribute("aria-selected", "false");
  });

  /**
   * The contradiction itself, stated as the thing that must never be on screen: the words
   * "walk-up code" over a control saying the member is not on one.
   */
  it("never calls the code a walk-up code while the control says otherwise", async () => {
    serve(IDENT);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    expect(document.body.textContent).not.toMatch(/walk-up code/i);
    expect(screen.getByText("Member code · any court")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Member code" })).toHaveAttribute("aria-selected", "true");
  });

  /**
   * <b>Manual activation, and it is a correctness decision.</b> Activating on arrow would
   * fire one code fetch per keypress, into an endpoint paced at one call per ten seconds and
   * sitting behind the auth rate-limit bucket that login shares. A keyboard user arrowing
   * across could rate-limit the club's sign-in.
   */
  it("moves focus on the arrow keys without activating, and activates on Enter", async () => {
    const stub = serve(BOOKING, memberDoorsOnFixture({ next_booking: memberDoorBookingFixture() }));
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    const booking = screen.getByRole("tab", { name: "Booking code" });
    const member = screen.getByRole("tab", { name: "Member code" });
    booking.focus();
    // Counted from HERE, not from zero: the page's own boundary refresh re-reads the code at
    // instants it has been told about, and this case is about what a KEYSTROKE costs.
    const before = codeRequests(stub).length;
    fireEvent.keyDown(booking, { key: "ArrowRight" });

    expect(document.activeElement).toBe(member);
    expect(member).toHaveAttribute("aria-selected", "false");
    expect(codeRequests(stub)).toHaveLength(before);
    expect(codeRequests(stub).some((c) => c.path.includes("kind="))).toBe(false);

    fireEvent.click(member);
    await waitFor(() => expect(codeRequests(stub).some((c) => c.path.includes("kind=ident"))).toBe(true));
  });

  it("wraps with the arrows and jumps with Home and End", async () => {
    serve(BOOKING, memberDoorsOnFixture({ next_booking: memberDoorBookingFixture() }));
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    const list = screen.getByRole("tablist", { name: "Which code to show" });
    const [booking, member] = screen.getAllByRole("tab");
    booking.focus();
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(member);
    fireEvent.keyDown(list, { key: "Home" });
    expect(document.activeElement).toBe(booking);
    fireEvent.keyDown(list, { key: "End" });
    expect(document.activeElement).toBe(member);
  });

  /** Roving tabindex: one stop for the group, on whichever segment is selected. */
  it("puts one tab stop on the group", async () => {
    serve(IDENT);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    const tabs = screen.getAllByRole("tab");
    expect(tabs.filter((t) => t.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Member code" })).toHaveAttribute("tabindex", "0");
  });

  /**
   * <b>Dimmed and focusable, never hidden.</b> A tab that vanishes teaches a member the app
   * is inconsistent; a `disabled` one is a hole in the tab order that explains nothing.
   */
  it("keeps a booking tab there, dimmed, with the reason in reach of both eyes and ears", async () => {
    serve(IDENT);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    const booking = screen.getByRole("tab", { name: /Booking code/ });
    expect(booking).toHaveAttribute("aria-disabled", "true");
    expect(booking).not.toBeDisabled();
    // Announced when focus reaches it…
    const why = document.getElementById(booking.getAttribute("aria-describedby")!);
    expect(why?.textContent).toMatch(/no booking of yours to make a code for/i);
    // …and visible, with the one thing that would change the answer.
    expect(screen.getByText(/no booking of yours to make a code for/i)).toBeVisible();
    expect(screen.getByRole("link", { name: "Book a court to get one" })).toHaveAttribute("href", "/schedule");
  });

  /** Tapping a dimmed tab costs nothing — it must not mint a code the server will not give. */
  it("does not ask for a code the club has already said it has none of", async () => {
    const stub = serve(IDENT);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");
    await waitFor(() => expect(codeRequests(stub)).toHaveLength(1));

    fireEvent.click(screen.getByRole("tab", { name: /Booking code/ }));
    expect(codeRequests(stub)).toHaveLength(1);
  });

  /**
   * The mutant this kills: inverting the unknown arm so an unanswerable question dims the
   * tab. The client's standing rule on this surface is to fail towards OFFERING.
   */
  it("leaves the booking tab live when the server was never asked to choose", async () => {
    // The member asked for `ident` outright, so the answer says nothing about bookings.
    rememberWalkUpChoice(true);
    serve(IDENT);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    expect(screen.getByRole("tab", { name: "Booking code" })).not.toHaveAttribute("aria-disabled");
  });

  it("points every segment at a panel that exists", async () => {
    serve(IDENT);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    const panels = screen.getAllByRole("tab").map((t) => t.getAttribute("aria-controls"));
    expect(panels.every(Boolean)).toBe(true);
    // The SELECTED segment's panel is on the page, holding the code itself.
    const selected = screen.getByRole("tab", { name: "Member code" });
    const panel = document.getElementById(selected.getAttribute("aria-controls")!);
    expect(panel).toHaveAttribute("role", "tabpanel");
    expect(panel!.querySelector('[aria-label^="QR code"]')).toBeTruthy();
  });

  /** The migration: same key, same values, so a member mid-session keeps their choice. */
  it("reads the checkbox's own stored value as the member-code preference", async () => {
    window.sessionStorage.setItem(WALK_UP_KEY, "1");
    const stub = serve(BOOKING, memberDoorsOnFixture({ next_booking: memberDoorBookingFixture() }));
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    await waitFor(() => expect(codeRequests(stub)[0].path).toContain("kind=ident"));
  });

  it("states the choice's lifetime only once the member has actually chosen", async () => {
    serve(IDENT);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");
    // Nothing chosen: the server picked, so there is no sticky choice to describe.
    expect(screen.queryByText(/keep getting your member code for the rest of this visit/)).toBeNull();

    cleanup();
    rememberWalkUpChoice(true);
    serve(IDENT);
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");
    expect(screen.getByText(/keep getting your member code for the rest of this visit/)).toBeInTheDocument();
  });

  /**
   * <b>D4 bug 5(b), as a rule over the whole page.</b> The product told members to look for a
   * control called "Use your member code instead" from branches that did not render one. The
   * guard is not "is that string gone" — it is "every control this page names by name is on
   * the page", which stays true when the next sentence is written.
   */
  it("never names a control that is not on the page", async () => {
    serve(BOOKING, memberDoorsOnFixture({ policy: "active_member", next_booking: memberDoorBookingFixture() }));
    renderPage(<MyCodePage />);
    await screen.findByLabelText("Your code");

    const text = document.body.textContent ?? "";
    for (const quoted of text.match(/"([^"]{2,40})"/g) ?? []) {
      const name = quoted.slice(1, -1);
      const named = screen.queryAllByRole("tab", { name }).length
        + screen.queryAllByRole("button", { name }).length
        + screen.queryAllByRole("link", { name }).length;
      expect(named, `the page quotes "${name}" and has no control called that`).toBeGreaterThan(0);
    }
    // And the button that does the same act wears the tab's own words, so there is one name
    // for one thing on a screen whose audience is not good with technology.
    expect(USE_MEMBER_CODE_INSTEAD).toBe("Switch to Member code");
  });
});
