import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import AdminSettingsPage from "./AdminSettings";
import { SETTINGS_FIXTURE, renderPage, stubFetch } from "../test/harness";

/**
 * The three things reviewer C found wrong with this screen as a DOCUMENT rather than as a
 * form: you cannot get to a section (C14), a refused field does not look refused and never
 * says so (C12), and the one derived sentence on it does not say where its number came from
 * (C13).
 */
describe("the settings screen as a document", () => {
  afterEach(() => vi.unstubAllGlobals());

  const routes = (over: Record<string, unknown> = {}) => [
    { path: "/api/v1/admin/settings/", body: { ...SETTINGS_FIXTURE, ...over } },
    { path: "/api/v1/admin/courts/", body: [] },
  ];

  /**
   * C14. Reviewer C counted the tab stops from the top of the document to the first door
   * setting: <b>seventy-six</b>. The page is nine cards and about thirty fields long and the
   * door numbers are seventh, so a keyboard user sent here by the doors page's "change how
   * long the lock is released" link paid for the booking, credits and court-box blocks first,
   * every time.
   */
  it("is nine named regions with a jump nav at the top", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    await screen.findByRole("heading", { name: "Booking" });

    // Every card is a region named by its own heading — `aria-labelledby` rather than an
    // `aria-label` repeating the words, so a rename cannot leave the region announcing the
    // old name.
    const regions = screen.getAllByRole("region");
    const names = regions.map((region) => region.getAttribute("aria-labelledby"))
      .filter((id): id is string => id !== null)
      .map((id) => document.getElementById(id)!.textContent);
    for (const heading of [
      "Booking", "Opening hours", "No-show & cancellation policy", "Credits & top-ups",
      "Court access", "Court boxes & identification", "Door gates", "Records", "Courts",
    ]) {
      expect(names, `no region named ${heading}`).toContain(heading);
    }

    const nav = screen.getByRole("navigation", { name: "Jump to section" });
    expect(within(nav).getAllByRole("link")).toHaveLength(9);
  });

  /**
   * And the jump moves FOCUS, not only the scroll. A bare fragment navigation leaves focus
   * at the top of the document, which is C15's finding in a different place: the person who
   * most needs the jump is the one it does nothing for.
   */
  it("focuses the section heading rather than only scrolling to it", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const nav = await screen.findByRole("navigation", { name: "Jump to section" });
    fireEvent.click(within(nav).getByRole("link", { name: "Door gates" }));

    const heading = screen.getByRole("heading", { name: "Door gates" });
    expect(heading).toHaveFocus();
    // The same attribute the router uses, which is what carries the scroll-margin that keeps
    // a heading out from under the sticky header, and the mouse/keyboard ring distinction.
    expect(heading).toHaveAttribute("data-route-heading");
  });

  /**
   * C12. A refused field was marked by <code>aria-invalid</code> and nothing else: measured,
   * a refused input and a good one were pixel-identical, and the complaint — which has been
   * on <code>aria-describedby</code> since B5 — is read when a screen reader ARRIVES at the
   * field, never when the value inside it goes bad. So an admin typing 400 into a field
   * bounded at 30 and tabbing on was told nothing at all until Save, thirty fields later.
   */
  it("marks a refused field and says so when the person leaves it", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const unlock = await screen.findByLabelText(/Unlock time/);
    fireEvent.change(unlock, { target: { value: "400" } });

    // The boundary says something is wrong with it, rather than being the border every other
    // field on the page is wearing.
    expect(unlock).toHaveAttribute("aria-invalid", "true");
    expect(unlock.className).toContain("border-danger-strong");

    // And a shape beside the words, because danger red on white is a colour and colour alone
    // is never the signal (SC 1.4.1).
    const field = unlock.closest("[data-invalid]")!;
    expect(field).toBeTruthy();
    expect(field.querySelector("svg")).toBeTruthy();

    // Nothing announced while the answer is half typed…
    const live = field.querySelector("[aria-live='polite']")!;
    expect(live.textContent).toBe("");
    // …and the complaint, named by the field it is about, when the person moves on.
    fireEvent.blur(unlock, { relatedTarget: document.body });
    await waitFor(() => expect(live.textContent).toContain("Unlock time (seconds)"));
    expect(live.textContent).toContain("between 1 and 30");

    // A message cannot outlive the mistake it is about.
    fireEvent.change(unlock, { target: { value: "3" } });
    expect(live.textContent).toBe("");
  });

  /**
   * C13. The derived horizon sentence was correct, unresponsive to the field directly beside
   * it, and silent about why — so an admin narrowing "Early entry" narrowed nothing and had
   * nothing on screen to tell them which two fields they wanted instead.
   */
  it("says which fields the door horizon was read from, and follows the policy select", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    // The default policy: the two fields on the OTHER card, named by the captions they wear.
    const openBasis = await screen.findByText(/it comes from/);
    expect(openBasis).toHaveTextContent("Offline roster reach (minutes)");
    expect(openBasis).toHaveTextContent("Lights on this early (minutes before a booking)");
    expect(openBasis).toHaveTextContent("Court boxes & identification");
    // And why the field beside it did nothing.
    expect(openBasis).toHaveTextContent("only sets a floor (currently 30)");
    // The half of the open policy a horizon sentence on its own would hide.
    expect(openBasis).toHaveTextContent("a member's own code opens a door whenever their membership is active");

    // The select is one of the fields ON SCREEN it is computed from.
    fireEvent.change(screen.getByLabelText(/Who may open a door/), { target: { value: "booking_window" } });
    const strictBasis = screen.getByText(/on this block and nothing else/);
    expect(strictBasis).toHaveTextContent("Early entry (minutes before a booking)");
    expect(strictBasis).not.toHaveTextContent("Offline roster reach");
    expect(strictBasis).not.toHaveTextContent("a member's own code");
  });

  /** The floor branch: raising early entry past the pair makes it the field that decides. */
  it("switches which field it names once early entry becomes the floor that wins", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    await screen.findByText(/it comes from/);
    fireEvent.change(screen.getByLabelText(/Early entry/), { target: { value: "200" } });

    const basis = screen.getByText(/it comes from/);
    expect(basis).toHaveTextContent("Early entry (minutes before a booking)");
    expect(basis).toHaveTextContent("would give 130");
    expect(basis).toHaveTextContent("never opens less early than this floor");
  });

  /** And the cap says it is a cap rather than leaving the arithmetic to be re-done. */
  it("says when the four-hour cap is what stopped the number", async () => {
    stubFetch(routes({ roster_window_minutes: 1440, activation_cue_window_minutes: 1440 }));
    renderPage(<AdminSettingsPage />);

    expect(await screen.findByText(/which is the cap, so the answer stops there/)).toBeInTheDocument();
  });
});
