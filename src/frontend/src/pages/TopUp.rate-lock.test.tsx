import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import TopUpPage from "./TopUp";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * The promise beside the figure, kept.
 *
 * <p>
 * The screen said, in as many words, <i>"This rate is locked in when you continue, so it
 * can't change while you're paying"</i> — and Continue registered the LIVE rate. Two
 * finders reproduced the same thing independently on the same day, from opposite
 * directions: an admin moving one member between groups, and an admin editing the club's
 * <code>credits_per_zar_regular</code>, which reaches every member with this screen open.
 * A member was shown 240.00 credits for R100, pressed Continue, and was given 160.
 * </p>
 *
 * <p>
 * <b>These assertions are about the money that leaves and the money that arrives</b>, not
 * about a sentence: what the POST carries, and what the screen does when the server says
 * the offer has moved. A screen can display "240.00 credits" perfectly while sending a
 * request the club will settle at 1.6.
 * </p>
 *
 * <p>
 * In its own file, deliberately: <code>TopUp.test.tsx</code> is being edited by another
 * lane in the same round, and two fixers redesigning one file is how correct fixes have
 * previously merged into defects here.
 * </p>
 */
describe("Top-up — the quoted rate is the registered rate", () => {
  const LEAGUE_OPTIONS = {
    block_zar: 100,
    min_zar: 100,
    max_zar: 1000,
    presets_zar: [100, 200, 500, 1000],
    conversion_rate: 2.4,
    // D2: the group the rate comes from, named — the class is gone.
    rate_group: { id: "g-league", name: "League", system_key: "league" },
  };

  const START = {
    topup_id: "aaaa1111-0000-0000-0000-000000000001",
    checkout_id: "CRS-001",
    redirect_url: "https://sandbox.payfast.co.za/eng/process",
    form_fields: [{ name: "signature", value: "deadbeef" }],
    quoted_credits: 240,
    conversion_rate: 2.4,
  };

  /** What the API answers when the club has moved away from the quote — 409, with the truth. */
  const MOVED = {
    error: "topup_rate_changed",
    conversion_rate: 1.6,
    quoted_credits: 160,
    // D2: the refusal names the group the NEW rate comes from — null is the club's standard rate.
    rate_group: null,
  };

  const submitted: HTMLFormElement[] = [];

  beforeEach(() => {
    submitted.length = 0;
    vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
      submitted.push(this);
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); });

  it("sends the rate the member is looking at, so the server can refuse a stale one", async () => {
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/credit/topup/options", body: LEAGUE_OPTIONS },
      { method: "POST", path: "/api/v1/credit/topup", body: START },
    ]);
    renderPage(<TopUpPage />);

    fireEvent.click(await screen.findByRole("radio", { name: "R100" }));
    expect(screen.getByText("240.00 credits")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue to PayFast" }));

    await vi.waitFor(() => expect(submitted.length).toBe(1));
    const post = stub.calls.find((c) => c.method === "POST" && c.path.includes("/credit/topup"))!;

    // Without this the server has nothing to compare and the member is registered at
    // whatever the club moved to while the tab was open.
    expect(post.body).toEqual({ amountZar: 100, quotedConversionRate: 2.4 });
  });

  it("stops on a moved rate, shows the new figure, and sends nobody to the gateway", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/credit/topup/options", body: LEAGUE_OPTIONS },
      { method: "POST", path: "/api/v1/credit/topup", status: 409, body: MOVED },
    ]);
    renderPage(<TopUpPage />);

    fireEvent.click(await screen.findByRole("radio", { name: "R100" }));
    expect(screen.getByText("240.00 credits")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue to PayFast" }));

    // The member is told, in their own words and with the number that matters. It is an
    // alert rather than a red error line: nothing went wrong and nothing was charged, the
    // price moved — so it is announced, and it says what the next press will do.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/The club changed its rate while this page was open/);
    expect(alert).toHaveTextContent("R100.00 now buys 160.00 credits");
    expect(alert).toHaveTextContent(/nothing has been sent to PayFast yet/);
    expect(alert).toHaveTextContent(/Press Continue again to pay at that rate/);

    // The preview is re-quoted rather than left lying: the stale 240.00 is gone.
    expect(screen.getByText("160.00 credits")).toBeInTheDocument();
    expect(screen.queryByText("240.00 credits")).not.toBeInTheDocument();
    // The summary under the figure says the new rate as well as the notice above it.
    expect(screen.getAllByText(/Every R1\.00 you pay adds 1\.60 cr to your wallet\./).length).toBeGreaterThan(1);
    // …and the line naming where the rate comes from moves with it (D2 — a group, not a class).
    expect(screen.getByTestId("your-rate")).toHaveTextContent("Your rate: the club's standard rate — 1.6 cr per R1");

    // And nothing was handed to PayFast — the defect's whole shape was a card form
    // appearing as the next thing the member saw.
    expect(submitted.length).toBe(0);
    expect(screen.getByRole("button", { name: "Continue to PayFast" })).not.toBeDisabled();
  });

  /**
   * The same refusal under StrictMode's mount -> cleanup -> mount.
   *
   * <p>
   * The shared harness renders without it, and StrictMode's double-invoke has already
   * produced two defects in this repo that unit tests could not see — a confirm button
   * stuck on "Working…" and a retry button dead for the life of the tab. The re-quote
   * writes options state from inside an error handler while the mount effect that fetched
   * those options has run twice, which is exactly the shape that goes wrong: a second
   * mount's fetch resolving after the refusal would put the stale 240.00 back on the
   * screen with "nothing has been sent to PayFast yet" still underneath it.
   * </p>
   */
  it("re-quotes correctly under StrictMode's double mount", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/credit/topup/options", body: LEAGUE_OPTIONS },
      { method: "POST", path: "/api/v1/credit/topup", status: 409, body: MOVED },
    ]);
    // The render OPTION, not a <StrictMode> element passed as the ui. Testing Library puts
    // its `wrapper` OUTSIDE the ui, so a <StrictMode> handed to renderPage lands inside the
    // harness's providers and double-invokes nothing — measured with a probe in round 7,
    // which is why this line changed. `reactStrictMode` is applied outside the wrapper.
    renderPage(<TopUpPage />, { reactStrictMode: true });

    fireEvent.click(await screen.findByRole("radio", { name: "R100" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to PayFast" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("R100.00 now buys 160.00 credits");
    expect(screen.getByText("160.00 credits")).toBeInTheDocument();
    expect(screen.queryByText("240.00 credits")).not.toBeInTheDocument();
    expect(submitted.length).toBe(0);
  });

  it("does not turn an unrelated refusal into a re-quote", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/credit/topup/options", body: LEAGUE_OPTIONS },
      { method: "POST", path: "/api/v1/credit/topup", status: 503, body: { error: "payments_not_configured" } },
    ]);
    renderPage(<TopUpPage />);

    fireEvent.click(await screen.findByRole("radio", { name: "R100" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to PayFast" }));

    expect(await screen.findByText("Payments aren't set up for this club yet — please ask an admin."))
      .toBeInTheDocument();
    expect(screen.getByText("240.00 credits")).toBeInTheDocument();
  });
});
