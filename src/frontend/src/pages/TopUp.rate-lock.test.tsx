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
 * directions: an admin moving one member's class, and an admin editing the club's
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
    member_class: "LeagueOrSenior" as const,
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
    member_class: "Regular",
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

    fireEvent.click(await screen.findByRole("button", { name: "R100" }));
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

    fireEvent.click(await screen.findByRole("button", { name: "R100" }));
    expect(screen.getByText("240.00 credits")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue to PayFast" }));

    // The member is told, in their own words and with the number that matters.
    expect(await screen.findByText(/The club changed the credit rate while this page was open/))
      .toBeInTheDocument();
    expect(screen.getByText(/R100\.00 now buys 160\.00 credits/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been charged/)).toBeInTheDocument();

    // The preview is re-quoted rather than left lying: the stale 240.00 is gone.
    expect(screen.getByText("160.00 credits")).toBeInTheDocument();
    expect(screen.queryByText("240.00 credits")).not.toBeInTheDocument();
    expect(screen.getByText(/At 1.6 credits \/ R1 \(regular rate\)/)).toBeInTheDocument();

    // And nothing was handed to PayFast — the defect's whole shape was a card form
    // appearing as the next thing the member saw.
    expect(submitted.length).toBe(0);
    expect(screen.getByRole("button", { name: "Continue to PayFast" })).not.toBeDisabled();
  });

  it("does not turn an unrelated refusal into a re-quote", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/credit/topup/options", body: LEAGUE_OPTIONS },
      { method: "POST", path: "/api/v1/credit/topup", status: 503, body: { error: "payments_not_configured" } },
    ]);
    renderPage(<TopUpPage />);

    fireEvent.click(await screen.findByRole("button", { name: "R100" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to PayFast" }));

    expect(await screen.findByText("Payments aren't set up for this club yet — please ask an admin."))
      .toBeInTheDocument();
    expect(screen.getByText("240.00 credits")).toBeInTheDocument();
  });
});
