import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import TopUpPage from "./TopUp";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";

/**
 * The checkout, which no member could complete.
 *
 * <p>
 * Two defects stacked. The screen POSTed <code>{ amountCredits }</code> against an API
 * reading <code>AmountZar</code>, so the amount bound to 0, the positivity guard fired,
 * and every attempt came back rejected — the member was told their amount was a bad
 * multiple of R100 while looking at R100. And behind that, the page then did
 * <code>window.location.href = redirect_url</code>: a GET to PayFast's process endpoint
 * with no merchant id, no amount and no signature. PayFast has no server-side checkout
 * registration; the signed form <i>is</i> the checkout, the provider had been building
 * and signing one all along, and nothing on the wire ever carried it.
 * </p>
 *
 * <p>
 * These assertions therefore look at what goes OUT — the request body and the form the
 * page builds — rather than at what the screen says. A screen can say "Redirecting…"
 * perfectly while sending PayFast nothing it can act on.
 * </p>
 */
describe("Top-up — what the checkout actually sends", () => {
  const OPTIONS = {
    block_zar: 100,
    min_zar: 100,
    max_zar: 1000,
    presets_zar: [100, 200, 500, 1000],
    conversion_rate: 1.6,
    member_class: "Regular" as const,
  };

  /** The signed field list PayFast's own process endpoint requires, in signature order. */
  const START = {
    topup_id: "aaaa1111-0000-0000-0000-000000000001",
    checkout_id: "CRS-001",
    redirect_url: "https://sandbox.payfast.co.za/eng/process",
    form_fields: [
      { name: "merchant_id", value: "10000100" },
      { name: "merchant_key", value: "46f0cd694581a" },
      { name: "return_url", value: "https://club.example/wallet/topup/aaaa1111/return" },
      { name: "cancel_url", value: "https://club.example/wallet/topup/aaaa1111/cancel" },
      { name: "notify_url", value: "https://club.example/api/v1/credit/topup/itn" },
      { name: "m_payment_id", value: "aaaa1111-0000-0000-0000-000000000001" },
      { name: "amount", value: "200.00" },
      { name: "item_name", value: "Court credits" },
      { name: "signature", value: "8f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f" },
    ],
    quoted_credits: 320,
    conversion_rate: 1.6,
  };

  // Overrides go FIRST. The stub breaks a length tie by declaration order, and an
  // override of the same path is the same length as the route it replaces.
  const routes = (overrides: Parameters<typeof stubFetch>[0] = []) => [
    ...overrides,
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/credit/topup/options", body: OPTIONS },
    { method: "POST", path: "/api/v1/credit/topup", body: START },
  ];

  /** Every form the page actually submitted — the last one is the checkout. */
  const submitted: HTMLFormElement[] = [];

  beforeEach(() => {
    submitted.length = 0;
    // jsdom does not implement `HTMLFormElement.prototype.submit` and records nothing, so
    // the submit is intercepted and the receiver kept. The form is what is on trial:
    // `submit()` takes no arguments, so it is only reachable through the receiver.
    vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
      submitted.push(this);
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); });

  it("sends the amount in RAND, under the name the API reads", async () => {
    const stub = stubFetch(routes());
    renderPage(<TopUpPage />);

    fireEvent.click(await screen.findByRole("button", { name: "R200" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to PayFast" }));

    await vi.waitFor(() => expect(stub.calls.some((c) => c.method === "POST")).toBe(true));
    const post = stub.calls.find((c) => c.method === "POST")!;

    // The bug, exactly: `amountCredits` bound to nothing on the server, `AmountZar` came
    // through as 0, and the positivity guard rejected every top-up the product could make.
    expect(post.body).toEqual({ amountZar: 200 });
    expect(post.raw).not.toContain("amountCredits");
  });

  it("POSTs the signed form to PayFast instead of following the URL as a GET", async () => {
    stubFetch(routes());
    renderPage(<TopUpPage />);

    fireEvent.click(await screen.findByRole("button", { name: "R200" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to PayFast" }));

    await vi.waitFor(() => expect(submitted.length).toBe(1));
    const form = submitted[0];

    // A real cross-origin form post, because the member must LAND on PayFast's card page
    // and fetch cannot navigate there.
    expect(form.method.toLowerCase()).toBe("post");
    expect(form.action).toBe(START.redirect_url);

    // Every signed field, by name and value and IN ORDER — PayFast's signature covers the
    // field sequence, so a reordered form is a rejected payment even with the right values.
    const sent = [...form.querySelectorAll("input")].map((i) => [i.name, i.value]);
    expect(sent).toEqual(START.form_fields.map((f) => [f.name, f.value]));

    // The one that made the whole path dead: without a signature PayFast cannot start a
    // payment at all, and a bare GET to the process URL carries none.
    expect(sent.map(([n]) => n)).toContain("signature");
    expect(sent.map(([n]) => n)).toContain("merchant_id");
    // cancel_url too — a member who backs out at PayFast had nowhere to land before.
    expect(sent.map(([n]) => n)).toContain("cancel_url");
  });

  it("takes the block, the cap and the rate from the club's settings, not from literals", async () => {
    // A club on R50 blocks to R5,000, at the league rate. Every one of these numbers was
    // hardcoded on the screen, so this club was quoted 1.6 when it settled at 2.4, offered
    // amounts it had stopped accepting and refused amounts it did accept — disagreeing with
    // its own server in both directions at once.
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      {
        path: "/api/v1/credit/topup/options",
        body: { block_zar: 50, min_zar: 50, max_zar: 5000, presets_zar: [50, 500, 2500, 5000], conversion_rate: 2.4, member_class: "LeagueOrSenior" },
      },
      { method: "POST", path: "/api/v1/credit/topup", body: START },
    ]);
    renderPage(<TopUpPage />);

    expect(await screen.findByText(/Min R50\.00 · Max R5000\.00 · Multiples of R50\.00 only/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "R2500" })).toBeInTheDocument();
    expect(screen.queryByText(/R1000\.00 only/)).not.toBeInTheDocument();

    // The rate the member is quoted is the club's, and the preview is that rate applied.
    expect(screen.getByText(/At 2.4 credits \/ R1 \(league \/ senior rate\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "R500" }));
    expect(screen.getByText("1200.00 credits")).toBeInTheDocument();

    // R2,500 is fine here and would have been refused by the old hardcoded R1,000 cap.
    fireEvent.click(screen.getByRole("button", { name: "R2500" }));
    expect(screen.getByRole("button", { name: "Continue to PayFast" })).not.toBeDisabled();
  });

  it("says why an amount is not accepted, rather than greying the button in silence", async () => {
    stubFetch(routes());
    renderPage(<TopUpPage />);

    const input = await screen.findByPlaceholderText(/Custom amount/);

    // The old predicate both produced the message and disabled the button, so every
    // branch of it was unreachable and the member had to infer the rule from a hint line.
    fireEvent.change(input, { target: { value: "150" } });
    expect(screen.getByText("Top-ups go in multiples of R100.00.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to PayFast" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "5000" } });
    expect(screen.getByText("The most you can top up at once is R1000.00.")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "50" } });
    expect(screen.getByText("The smallest top-up is R100.00.")).toBeInTheDocument();

    // `parseFloat` took "200abc" as 200 and "1e3" as 1000 and enabled the button on both,
    // so the member submitted an amount that is not the one they typed.
    fireEvent.change(input, { target: { value: "200abc" } });
    expect(screen.getByText("That isn't a number — enter an amount in rand.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to PayFast" })).toBeDisabled();
  });

  it("turns a rejection from the API into a sentence, never a code", async () => {
    stubFetch(routes([
      { method: "POST", path: "/api/v1/credit/topup", status: 503, body: { error: "payments_not_configured" } },
    ]));
    renderPage(<TopUpPage />);

    fireEvent.click(await screen.findByRole("button", { name: "R100" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to PayFast" }));

    expect(await screen.findByText("Payments aren't set up for this club yet — please ask an admin.")).toBeInTheDocument();
    expect(screen.queryByText(/payments_not_configured/)).not.toBeInTheDocument();
  });
});
