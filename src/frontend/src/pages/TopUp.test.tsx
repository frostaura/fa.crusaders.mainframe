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
    const post = stub.calls.find((c) => c.method === "POST" && c.path.includes("/credit/topup"))!;

    // The bug, exactly: `amountCredits` bound to nothing on the server, `AmountZar` came
    // through as 0, and the positivity guard rejected every top-up the product could make.
    // `quotedConversionRate` rides along so the server can refuse a stale offer rather than
    // register the member at a rate the screen never showed them — see TopUp.rate-lock.test.tsx.
    expect(post.body).toEqual({ amountZar: 200, quotedConversionRate: 1.6 });
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

  /**
   * Item 12 on the page that sends a member to a payment gateway.
   *
   * <p>
   * `affirm` on Continue and `decline` on Cancel, and NO outcome phase on either: Continue
   * ends in a redirect, so "it worked" is PayFast's own page arriving, and a tick drawn over
   * a button the member is being taken away from would be a claim about a payment that has
   * not happened. The glyph and the press are the whole of the adoption here.
   * </p>
   */
  it("marks Continue the affirm and Cancel the decline", async () => {
    stubFetch(routes());
    renderPage(<TopUpPage />);
    const go = await screen.findByRole("button", { name: "Continue to PayFast" });
    expect(go).toHaveAttribute("data-intent", "affirm");
    expect(go.querySelector("svg[aria-hidden]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute("data-intent", "decline");
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

  /**
   * `Number` fixed "200abc" and left the rest of the family behind: "1e3" enabled the
   * button and quoted 1600 credits, which is R1000 the member did not ask for. The
   * comment beside the code asserted the opposite, which is how it survived a round.
   */
  it("refuses programmer notation in a rand field", async () => {
    stubFetch(routes());
    renderPage(<TopUpPage />);

    const input = await screen.findByPlaceholderText(/Custom amount/);
    const submit = screen.getByRole("button", { name: "Continue to PayFast" });

    for (const typed of ["1e3", "1E3", "0x64", "0b1100100", "1_000", "1,000", "Infinity", "+200", "2e2"]) {
      fireEvent.change(input, { target: { value: typed } });
      expect(screen.getByText("That isn't a number — enter an amount in rand.")).toBeInTheDocument();
      expect(submit).toBeDisabled();
      expect(screen.queryByText(/You receive/)).not.toHaveTextContent(/1600|320/);
    }

    // Nothing a member actually types is caught by the same net.
    fireEvent.change(input, { target: { value: "200" } });
    expect(submit).not.toBeDisabled();
    fireEvent.change(input, { target: { value: " 200 " } });
    expect(submit).not.toBeDisabled();
    // And a negative still gets the sentence about zero, not the one about digits.
    fireEvent.change(input, { target: { value: "-100" } });
    expect(screen.getByText("Enter an amount greater than zero.")).toBeInTheDocument();
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

/**
 * L-F1 / N-F1 / K-F3 — the best-corroborated defect of round 3, driven twice each by three
 * independent finders.
 *
 * <p>
 * The screen fetched the club's rate once on mount and then told the member, in so many
 * words, that "this rate is locked in when you continue, so it can't change while you're
 * paying". It is not the rate that was locked — it is whatever the server resolves when the
 * POST lands. So an admin editing <code>credits_per_zar_*</code>, or that member's class
 * changing, left a member pressing Continue on 480.00 credits and being registered at 320,
 * with nothing between the offer and the ledger row to say so.
 * </p>
 *
 * <p>
 * Two lanes closed this in the same round, by different seams. One read the rate off the
 * POST's own answer and declined to go on — a check the server does not enforce, run after
 * the pending row had already been written at the new rate. The other sends the quoted rate
 * WITH the amount so the server refuses with <code>409 topup_rate_changed</code> before
 * writing anything. The second shipped, so these assertions drive the refusal rather than a
 * 200 at a surprising rate. What they are really about is unchanged: what the page does with
 * that answer, and the sentence beside the figure. Copy is a promise, and this programme has
 * now found five screens promising what no code path keeps.
 * </p>
 */
describe("Top-up — the quoted rate against the registered one", () => {
  const LEAGUE = {
    block_zar: 100, min_zar: 100, max_zar: 1000, presets_zar: [100, 200, 500, 1000],
    conversion_rate: 2.4, member_class: "LeagueOrSenior" as const,
  };

  /** What the server answers once the club has demoted the member behind their back. */
  const RATE_MOVED = {
    error: "topup_rate_changed",
    conversion_rate: 1.6,
    quoted_credits: 320,
    member_class: "Regular",
  };

  /** …and what it answers on the second press, at the figure the member has now seen. */
  const REGISTERED = {
    topup_id: "aaaa1111-0000-0000-0000-000000000001",
    checkout_id: "CRS-002",
    redirect_url: "https://sandbox.payfast.co.za/eng/process",
    form_fields: [{ name: "signature", value: "deadbeef" }],
    quoted_credits: 320,
    conversion_rate: 1.6,
  };

  const submitted: HTMLFormElement[] = [];
  beforeEach(() => {
    submitted.length = 0;
    vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
      submitted.push(this);
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); });

  it("does not hand the member to PayFast at a rate they were never shown", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/credit/topup/options", body: LEAGUE },
      { method: "POST", path: "/api/v1/credit/topup", status: 409, body: RATE_MOVED },
    ]);
    renderPage(<TopUpPage />);

    fireEvent.click(await screen.findByRole("button", { name: "R200" }));
    // The offer the member is looking at when they press the button.
    expect(screen.getByText("480.00 credits")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue to PayFast" }));

    // The whole finding: the browser went to PayFast to pay R200 for a top-up the server
    // had already written at 1.6, and the first place 320 appeared was a ledger row.
    await screen.findByRole("alert");
    expect(submitted).toHaveLength(0);

    // …and the member is told, in the club's own figures, what changed.
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/The club changed its rate while this page was open/);
    expect(alert).toHaveTextContent("320.00 credits");
    expect(alert).toHaveTextContent("1.6 credits / R1");
    // The preview moves with it, so nothing on screen still says 480.
    expect(screen.queryByText("480.00 credits")).not.toBeInTheDocument();
    expect(screen.getByText("320.00 credits")).toBeInTheDocument();
    // …and the class label moves with it too, rather than being dropped. A headed run against
    // the client-side version of this fix showed "At 2.4 credits / R1 (regular rate)" — the new
    // number beside the old reason for it, a second small untruth arriving with the fix for the
    // first. That lane dropped the label. It does not have to be dropped: the refusal carries
    // `member_class`, so the line can name the RIGHT class, which is what is asserted here.
    expect(screen.getByText(/At 1\.6 credits \/ R1 \(regular rate\)/)).toBeInTheDocument();
    expect(screen.queryByText(/league \/ senior rate/)).not.toBeInTheDocument();
  });

  it("goes through on the second press, now that the member has seen the real figure", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/credit/topup/options", body: LEAGUE },
      // Refused, then accepted: the member's second press agrees to the club's new rate, and
      // the quote it now sends matches, so the server has nothing left to refuse.
      { method: "POST", path: "/api/v1/credit/topup", status: [409, 200], sequence: [RATE_MOVED, REGISTERED], body: RATE_MOVED },
    ]);
    renderPage(<TopUpPage />);

    fireEvent.click(await screen.findByRole("button", { name: "R200" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to PayFast" }));
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Continue to PayFast" }));

    // A hold that cannot be got past is a dead end, which is the other half of this
    // programme's error-copy rule.
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
  });

  /**
   * The fixture, varied. The check above passes trivially if the page simply never posts the
   * form, so the ordinary case — the club's rate is exactly what the screen said — has to be
   * driven through the same code path. It also pins the wire field the refusal depends on: a
   * POST that stops sending the quote is a POST the server can no longer refuse, and every
   * assertion above would still pass while the defect walked back in.
   */
  it("sends the payment straight on when the rate has not moved, and sends the quote with it", async () => {
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/credit/topup/options", body: LEAGUE },
      {
        method: "POST", path: "/api/v1/credit/topup",
        body: { ...REGISTERED, quoted_credits: 480, conversion_rate: 2.4 },
      },
    ]);
    renderPage(<TopUpPage />);

    fireEvent.click(await screen.findByRole("button", { name: "R200" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to PayFast" }));

    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const posted = stub.calls.filter((c) => c.method === "POST" && c.path.startsWith("/api/v1/credit/topup"));
    expect(posted.map((c) => c.body)).toEqual([{ amountZar: 200, quotedConversionRate: 2.4 }]);
  });

  it("does not tell the member the rate cannot change, because it can", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/credit/topup/options", body: LEAGUE },
      { method: "POST", path: "/api/v1/credit/topup", status: 409, body: RATE_MOVED },
    ]);
    renderPage(<TopUpPage />);

    // The retired sentence, word for word off the three finders' screenshots.
    expect(await screen.findByText(/At 2.4 credits \/ R1/)).toBeInTheDocument();
    expect(screen.queryByText(/locked in when you continue/)).not.toBeInTheDocument();
    expect(screen.queryByText(/can't change while you're paying\./)).not.toBeInTheDocument();
    // What is true, and what the code above now keeps.
    expect(screen.getByText(/fixed the moment the club registers this payment/)).toBeInTheDocument();
    expect(screen.getByText(/we'll show you the new figure before sending you there/)).toBeInTheDocument();
  });
});
