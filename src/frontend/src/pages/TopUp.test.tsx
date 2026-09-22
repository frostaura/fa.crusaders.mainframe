import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import TopUpPage from "./TopUp";
import { renderPage, signIn, signOut, stubFetch } from "../test/harness";
import { resetClubCurrencySymbol, setClubCurrencySymbol } from "../lib/currency";

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

    fireEvent.click(await screen.findByRole("button", { name: "R200.00" }));
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

    fireEvent.click(await screen.findByRole("button", { name: "R200.00" }));
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
    expect(screen.getByRole("button", { name: "R2500.00" })).toBeInTheDocument();
    expect(screen.queryByText(/R1000\.00 only/)).not.toBeInTheDocument();

    // The rate the member is quoted is the club's, and the preview is that rate applied.
    // Both legs in words, because they are now written in the same symbol: "1200.00 credits"
    // said which quantity it was by carrying a different unit, and "R1200.00" cannot.
    expect(screen.getByText(/Every R1\.00 you pay adds R2\.40 to your wallet \(league \/ senior rate\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "R500.00" }));
    expect(screen.getByText("R1200.00")).toBeInTheDocument();

    // R2,500 is fine here and would have been refused by the old hardcoded R1,000 cap.
    fireEvent.click(screen.getByRole("button", { name: "R2500.00" }));
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
    expect(screen.getByText("That isn't a number — enter digits only, like 200.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to PayFast" })).toBeDisabled();
  });

  /**
   * The currency NAME is gone from this screen, and that is a decision rather than an
   * oversight.
   *
   * <p>
   * "Enter an amount in rand" was true for one club. The symbol is `tenant_settings`, a club
   * on CHF gets `CHF100.00` in the same field, and there is no way to derive "Swiss francs"
   * from a sentence that hardcodes "rand" — so the sentence says what is wrong with what was
   * typed and lets the symbol beside the field name the money. `spokenCurrencyName` is where
   * a noun is still produced, for the things a screen reader SAYS.
   * </p>
   */
  it("does not name one country's currency in a field every club shares", async () => {
    stubFetch(routes());
    renderPage(<TopUpPage />);

    const input = await screen.findByPlaceholderText(/Custom amount/);
    // Nothing typed is not an error — the three states stay three, and the message for an
    // empty field is a fallback the disabled button keeps out of reach.
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByText(/Enter an amount/)).toBeNull();
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByText("That isn't a number — enter digits only, like 200.")).toBeInTheDocument();

    // The SPOKEN line is allowed to say "rand" — `spokenMoney` derives it from the club's own
    // symbol and answers nothing at all for a symbol it cannot name. What is checked here is
    // the visible prose, which is where a hardcoded country was wrong.
    const seen = [...document.body.querySelectorAll("p, span, label, button")]
      .filter((el) => !el.className.includes("sr-only"))
      .map((el) => el.textContent ?? "")
      .join(" ");
    expect(seen).not.toMatch(/\brand\b/i);
    expect(seen).not.toMatch(/\bZAR\b/);
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
      expect(screen.getByText("That isn't a number — enter digits only, like 200.")).toBeInTheDocument();
      expect(submit).toBeDisabled();
      // The wallet leg is blank, not quoted. This used to read the "You receive" row by its
      // label; the row is now named for the side it is on, and the figure is what matters.
      expect(screen.queryByText("R1600.00")).toBeNull();
      expect(screen.queryByText("R320.00")).toBeNull();
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

    fireEvent.click(await screen.findByRole("button", { name: "R100.00" }));
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

    fireEvent.click(await screen.findByRole("button", { name: "R200.00" }));
    // The offer the member is looking at when they press the button.
    expect(screen.getByText("R480.00")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue to PayFast" }));

    // The whole finding: the browser went to PayFast to pay R200 for a top-up the server
    // had already written at 1.6, and the first place 320 appeared was a ledger row.
    await screen.findByRole("alert");
    expect(submitted).toHaveLength(0);

    // …and the member is told, in the club's own figures, what changed. Both figures wear the
    // same symbol now, so the alert has to say which is which in words.
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/The club changed its rate while this page was open/);
    expect(alert).toHaveTextContent("R200.00 now adds R320.00 to your wallet instead");
    // The preview moves with it, so nothing on screen still says 480.
    expect(screen.queryByText("R480.00")).not.toBeInTheDocument();
    expect(screen.getByText("R320.00")).toBeInTheDocument();
    // …and the class label moves with it too, rather than being dropped. A headed run against
    // the client-side version of this fix showed "At 2.4 credits / R1 (regular rate)" — the new
    // number beside the old reason for it, a second small untruth arriving with the fix for the
    // first. That lane dropped the label. It does not have to be dropped: the refusal carries
    // `member_class`, so the line can name the RIGHT class, which is what is asserted here.
    expect(screen.getByText(/Every R1\.00 you pay adds R1\.60 to your wallet \(regular rate\)/)).toBeInTheDocument();
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

    fireEvent.click(await screen.findByRole("button", { name: "R200.00" }));
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

    fireEvent.click(await screen.findByRole("button", { name: "R200.00" }));
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
    expect(await screen.findByText(/Every R1\.00 you pay adds R2\.40 to your wallet/)).toBeInTheDocument();
    expect(screen.queryByText(/locked in when you continue/)).not.toBeInTheDocument();
    expect(screen.queryByText(/can't change while you're paying\./)).not.toBeInTheDocument();
    // What is true, and what the code above now keeps. The apostrophes are gone from the
    // rendered sentence as well as from the source — lizard's .tsx lexer opens a string on a
    // bare one in JSX text — so these read "cannot" and "we will".
    expect(screen.getByText(/fixed the moment the club registers this payment/)).toBeInTheDocument();
    expect(screen.getByText(/we will show you the new figure before sending you there/)).toBeInTheDocument();
  });
});

/**
 * The conversion boundary itself — the one screen where a member meets both quantities at
 * once, now that they are written in the same symbol.
 *
 * <p>
 * <code>lib/currency.ts</code> states the rule this block exists to enforce: the exchange
 * rate is invisible everywhere except here, so this screen must say <b>both legs in words</b>
 * — what leaves the card, and what arrives in the wallet. "You pay R100.00 / You receive
 * R160.00" with no sentence between them is not a rounding quibble, it is a screen that looks
 * like it has a bug in it.
 * </p>
 */
describe("Top-up — both legs of the conversion, in words", () => {
  const OPTIONS = {
    block_zar: 100, min_zar: 100, max_zar: 1000, presets_zar: [100, 200, 500, 1000],
    conversion_rate: 1.6, member_class: "Regular" as const,
  };

  const routes = (options: Record<string, unknown> = OPTIONS) => [
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/credit/topup/options", body: options },
  ];

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); resetClubCurrencySymbol(); });

  it("names the side each figure is on, and where the difference comes from", async () => {
    stubFetch(routes());
    renderPage(<TopUpPage />);

    fireEvent.click(await screen.findByRole("button", { name: "R200.00" }));

    // Neither row is a bare "You pay" / "You receive" any more: with one symbol on both
    // legs, the label is the only thing left that says which quantity a figure is. Scoped to
    // the preview, because "R200.00" is also the preset button that was just pressed — which
    // is the whole hazard in one symbol for both quantities.
    const preview = within(screen.getByTestId("conversion-preview"));
    expect(preview.getByText("You pay PayFast")).toBeInTheDocument();
    expect(preview.getByText("Added to your wallet")).toBeInTheDocument();
    expect(preview.getByText("R200.00")).toBeInTheDocument();
    expect(preview.getByText("R320.00")).toBeInTheDocument();

    // …and the sentence that stops the bigger number reading as a typo.
    expect(preview.getByText("The club adds R120.00 on top of what you pay.")).toBeInTheDocument();
    expect(preview.getByText(/Every R1\.00 you pay adds R1\.60 to your wallet/)).toBeInTheDocument();

    // The residual risk `currency.ts` names: a member reading a wallet as withdrawable cash.
    expect(preview.getByText(/It is not cash and cannot be paid back out/)).toBeInTheDocument();
  });

  it("says the two figures out loud, rather than spelling the symbol as a letter", async () => {
    stubFetch(routes());
    renderPage(<TopUpPage />);

    fireEvent.click(await screen.findByRole("button", { name: "R200.00" }));

    // An aria-label REPLACES an element's contents, and a reader handed "R320.00" announces
    // the R. The spoken line carries the noun the symbol cannot.
    expect(screen.getByText("Paying 200.00 rand adds 320.00 rand to your wallet.")).toBeInTheDocument();
    // The amount field, too: "Amount (R)" is announced as a letter in brackets.
    expect(screen.getByRole("textbox", { name: "Amount in rand" })).toBeInTheDocument();
  });

  it("carries a multi-character symbol through every figure, and names it out loud", async () => {
    setClubCurrencySymbol("CHF");
    stubFetch(routes());
    renderPage(<TopUpPage />);

    fireEvent.click(await screen.findByRole("button", { name: "CHF200.00" }));

    expect(screen.getByText("CHF320.00")).toBeInTheDocument();
    expect(screen.getByText("The club adds CHF120.00 on top of what you pay.")).toBeInTheDocument();
    expect(screen.getByText(/Every CHF1\.00 you pay adds CHF1\.60 to your wallet/)).toBeInTheDocument();
    expect(screen.getByText("Paying 200.00 Swiss francs adds 320.00 Swiss francs to your wallet.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Amount in Swiss francs" })).toBeInTheDocument();
  });

  /**
   * A symbol this product cannot name is not a symbol this product guesses at. The figure is
   * still spoken — as a bare number, inside a sentence that says what the number is — and the
   * field falls back to "Amount", which is true in any currency.
   */
  it("degrades to a bare number for a symbol it has no noun for", async () => {
    setClubCurrencySymbol("₸");
    stubFetch(routes());
    renderPage(<TopUpPage />);

    fireEvent.click(await screen.findByRole("button", { name: "₸200.00" }));

    expect(screen.getByText("Paying 200.00 adds 320.00 to your wallet.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Amount" })).toBeInTheDocument();
  });

  it("treats an absent symbol exactly as the default, never as the last club's", async () => {
    setClubCurrencySymbol("CHF");
    setClubCurrencySymbol(undefined);
    stubFetch(routes());
    renderPage(<TopUpPage />);

    expect(await screen.findByRole("button", { name: "R200.00" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^CHF/ })).toBeNull();
  });

  /**
   * The fixture varied where it matters: the club that gives nothing away, and the club that
   * takes a cut. Neither may be told it is getting a bonus, and the rate sentence has to stay
   * true in both — it is the only place on the screen the rate still appears.
   */
  it("claims no bonus when the club adds nothing, and none when it adds less than nothing", async () => {
    stubFetch(routes({ ...OPTIONS, conversion_rate: 1 }));
    const flat = renderPage(<TopUpPage />);
    fireEvent.click(await screen.findByRole("button", { name: "R200.00" }));
    expect(screen.queryByText(/on top of what you pay/)).toBeNull();
    expect(screen.getByText(/Every R1\.00 you pay adds R1\.00 to your wallet/)).toBeInTheDocument();
    flat.unmount();

    vi.unstubAllGlobals();
    stubFetch(routes({ ...OPTIONS, conversion_rate: 0.5 }));
    renderPage(<TopUpPage />);
    fireEvent.click(await screen.findByRole("button", { name: "R200.00" }));
    expect(screen.queryByText(/on top of what you pay/)).toBeNull();
    // R100.00 is also a preset button here, so the wallet leg is read inside the preview.
    expect(within(screen.getByTestId("conversion-preview")).getByText("R100.00")).toBeInTheDocument();
    expect(screen.getByText(/Every R1\.00 you pay adds R0\.50 to your wallet/)).toBeInTheDocument();
  });

  it("holds its shape on a very large amount", async () => {
    stubFetch(routes({ ...OPTIONS, max_zar: 1_000_000, presets_zar: [1_000_000] }));
    renderPage(<TopUpPage />);

    fireEvent.click(await screen.findByRole("button", { name: "R1000000.00" }));
    expect(screen.getByText("R1600000.00")).toBeInTheDocument();
    expect(screen.getByText("The club adds R600000.00 on top of what you pay.")).toBeInTheDocument();
  });

  /** Nothing chosen yet: three states, and "—" is the one that means "nothing typed". */
  it("shows neither leg, and no bonus sentence, before an amount is valid", async () => {
    stubFetch(routes());
    renderPage(<TopUpPage />);

    const input = await screen.findByPlaceholderText(/Custom amount/);
    fireEvent.change(input, { target: { value: "150" } });

    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.queryByText(/on top of what you pay/)).toBeNull();
    expect(screen.queryByText(/adds .* to your wallet\.$/)).toBeNull();
  });
});
