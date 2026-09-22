import { describe, expect, it, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import WalletPage from "../../pages/Wallet";
import { renderPage, stubFetch } from "../../test/harness";
import {
  BALANCE_SENTENCE, creditArrivedSentence, creditLeftSentence,
} from "../../lib/walletCopy";

/**
 * The wallet — items 8 and D4's §2.6.
 *
 * <p>
 * Two rules carry most of this file. <b>Zero is not "running low"</b>: a member with 0.00
 * cannot book anything at all, and the product was telling them, in the same amber it uses
 * for 49.99, that their balance was getting on. And <b>a number changing in a corner is not
 * an event anybody notices</b> — least of all a screen-reader user, for whom a re-rendered
 * figure is not an announcement at all.
 * </p>
 */

const ROW = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  at: "2026-09-21T18:31:00Z",
  from: "Club", to: "Thandi Probe",
  amountCredits: 200, signedAmountCredits: 200,
  type: "AdminAdjustment",
  comment: "Desk credit",
  subjectUserId: "u-member", subjectName: "Thandi Probe",
  actorUserId: "u-admin", actorName: "Sipho at the desk",
  relatedBookingId: null,
  ...over,
});

function serveWallet(balance: number, entries: Record<string, unknown>[] = []) {
  return stubFetch([
    { path: "/api/v1/wallet", body: { balance_credits: balance, entries, total_entries: entries.length, offset: 0, limit: 100 } },
  ]);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("zero is a different thing from low", () => {
  /*
    The rule itself moved. It is now `walletTone` in `lib/balance` — one function for the chip,
    the wallet page and the grid's empty-wallet banner, which each used to decide separately
    and disagreed at 0.004. `lib/wallet-tone.test.ts` holds the table of balances and
    the 0.004 case against that one function; what stays here is what this PAGE does with the
    answer.
  */

  it("says what an empty wallet STOPS, not that it is getting on", async () => {
    serveWallet(0);
    renderPage(<WalletPage />);

    expect(await screen.findByText(BALANCE_SENTENCE.zero)).toBeInTheDocument();
    expect(screen.queryByText(/running low/i)).toBeNull();
    // And the one control that helps is the primary one, named for the errand.
    expect(screen.getByRole("link", { name: /Top up to start booking/ })).toHaveAttribute("href", "/wallet/topup");
  });

  it("keeps the caution for a balance that really is running down", async () => {
    serveWallet(20);
    renderPage(<WalletPage />);

    expect(await screen.findByText(BALANCE_SENTENCE.low)).toBeInTheDocument();
    expect(screen.queryByText(BALANCE_SENTENCE.zero)).toBeNull();
  });

  it("says nothing alarming at a comfortable balance", async () => {
    serveWallet(500);
    renderPage(<WalletPage />);

    expect(await screen.findByText(BALANCE_SENTENCE.fine)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Top up" })).toBeInTheDocument();
  });
});

describe("what a member sees when the club tops them up while they watch", () => {
  /**
   * The sentence is read off the ledger row, never assumed. "The club added R200.00" is
   * false if a partner cancelled a court in another tab, and the row is the only thing that
   * can tell them apart.
   */
  it.each([
    ["AdminAdjustment", "Sipho at the desk added R200.00 to your wallet."],
    ["TopUp", "Your top-up landed: R200.00 is in your wallet."],
    ["CancellationRefund", "A cancelled booking put R200.00 back in your wallet."],
    ["PaymentReversal", "A payment was reversed: R200.00 is back in your wallet."],
  ] as const)("names a %s for what it was", (type, sentence) => {
    expect(creditArrivedSentence(200, type, "Sipho at the desk")).toBe(sentence);
  });

  /** No row to match, or an actor who is the member themselves: the neutral, true sentence. */
  it("falls back to a sentence that is true whoever caused it", () => {
    expect(creditArrivedSentence(200, null, null)).toBe("Your wallet went up by R200.00.");
    expect(creditArrivedSentence(200, "AdminAdjustment", null)).toBe("The club added R200.00 to your wallet.");
  });

  /**
   * Money leaving is not an error. Spending your own money on a court you chose is the
   * product working, and a red alarm over it is the app telling a member off for using it.
   */
  it("words money going out plainly, and never as a failure", () => {
    expect(creditLeftSentence(50, "BookingCharge")).toBe("R50.00 went on a court booking.");
    expect(creditLeftSentence(50, null)).toBe("R50.00 left your wallet.");
    for (const type of ["BookingCharge", "LightsPurchase", "NoShowPenalty", null] as const) {
      expect(creditLeftSentence(50, type)).not.toMatch(/fail|error|wrong/i);
    }
  });

  it("announces the arrival exactly once, with the amount in it", async () => {
    /*
      The club's answer is held in a variable rather than a `sequence`, because the page and
      the balance provider both read `/wallet` and a positional sequence makes which of them
      gets which answer a race. This is the club changing its mind about a member's balance,
      which is what actually happens.
    */
    const club = { balance_credits: 0, entries: [] as unknown[], total_entries: 0, offset: 0, limit: 100 };
    stubFetch([{ path: "/api/v1/wallet", respond: () => ({ ...club }) }]);
    renderPage(<WalletPage />);
    await screen.findByText(BALANCE_SENTENCE.zero);

    club.balance_credits = 200;
    club.entries = [ROW()];
    club.total_entries = 1;
    /*
      Re-read the way a member does. The stream re-read is the same code path — it lands a
      new figure and new rows in one batch — and driving it from the button is what makes
      this case independent of whether a provider happened to connect, which is the point of
      watching the PAINTED figure rather than the stream's.
    */
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh" })); });

    await screen.findByText(/added R200\.00 to your wallet/);
    // ONE announcement. The toast carries role="status" per instance and the viewport
    // deliberately carries none.
    expect(within(document.body).queryAllByText(/added R200\.00/)).toHaveLength(1);
    expect(document.querySelectorAll("[role=alert]")).toHaveLength(0);
  });

  /** The figure itself is never a live region: a tween inside one is sixty announcements. */
  it("never puts a live region on the balance figure", async () => {
    serveWallet(500);
    renderPage(<WalletPage />);
    await screen.findByText(BALANCE_SENTENCE.fine);

    // The figure is written TWICE now — "R500.00" for the eye, `aria-hidden`, and "500.00 rand"
    // in an `sr-only` span for the ear, because a currency symbol is announced as a letter. So
    // the query has to name which one it means; the live-region rule is about the element that
    // holds them both.
    const figure = screen.getByText("R500.00").closest("p")!;
    expect(within(figure).getByText("500.00 rand").className).toContain("sr-only");
    expect(figure.getAttribute("aria-live")).toBeNull();
    expect(figure.getAttribute("role")).toBeNull();
    // And it is tabular, so a count-up cannot reflow the card on every frame.
    expect(figure.className).toContain("tabular-nums");
  });
});

describe("the ledger's clock", () => {
  it("writes the club's day in the club's format, not the reader's", async () => {
    serveWallet(200, [ROW()]);
    renderPage(<WalletPage />);

    // 18:31Z on 21 September 2026 is 20:31 in Johannesburg, which the suite pins as the club.
    expect(await screen.findByText(/20:31/)).toBeInTheDocument();
    // Never the reader-locale form this column used to print.
    expect(screen.queryByText(/8:31 PM/)).toBeNull();
    expect(screen.queryByText(/9\/21\/26/)).toBeNull();
  });

  it("says once, under the list, whose clock it is", async () => {
    serveWallet(200, [ROW()]);
    renderPage(<WalletPage />);

    const notes = await screen.findAllByText("Times are the club's own.");
    expect(notes).toHaveLength(1);
  });

  it("does not claim a clock convention when there are no rows to read", async () => {
    serveWallet(0);
    renderPage(<WalletPage />);
    await screen.findByText(BALANCE_SENTENCE.zero);

    expect(screen.queryByText("Times are the club's own.")).toBeNull();
  });
});

describe("a wallet that will not load", () => {
  it("says so rather than showing a confident zero", async () => {
    stubFetch([{ path: "/api/v1/wallet", status: 500, body: { error: "boom" } }]);
    renderPage(<WalletPage />);

    expect(await screen.findByText(/Couldn't load wallet/)).toBeInTheDocument();
    // Three states, not two: a failed read is not an empty wallet, and must not be dressed as
    // one — "you can't book until you top up" over a read that never landed is a lie.
    expect(screen.queryByText(BALANCE_SENTENCE.zero)).toBeNull();
    await waitFor(() => expect(screen.queryByText("0.00")).toBeNull());
    cleanup();
  });
});
