import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError, NetworkError } from "./api";
import { AuthProvider } from "./auth";
import { BalanceProvider, useBalance } from "./balance";
import { heldFrom, LIVE_BALANCE_POLICY, type BalanceFrame, type BalanceTransport } from "./liveBalance";
import { inviteMoney } from "./playersApi";
import {
  firstName, heldLine, listNames, OWED_BACK_EXPLAINER, owedBackLine, owedBackQuoteLine, PLAYERS_REFUSAL, playersRefusal,
} from "./playersCopy";
import { signIn, signOut, stubFetch } from "../test/harness";

/**
 * P11's foundation: the refusal sentences every players screen shares, the held-credit
 * arithmetic (D11 §3a — spend decisions read SPENDABLE, never the raw balance), and the wallet
 * stream's named `notification` frame reaching the bell's count.
 */

afterEach(() => signOut());

const refusal = (status: number, body: Record<string, unknown>) => new ApiError(status, body);

describe("playersRefusal — every code is a sentence, never the generic fallback", () => {
  const generic = playersRefusal(refusal(418, { error: "something_nobody_named" }));

  it.each(Object.keys(PLAYERS_REFUSAL))("%s has its own sentence", (code) => {
    const sentence = playersRefusal(refusal(409, { error: code }));
    expect(sentence).toBe(PLAYERS_REFUSAL[code]);
    expect(sentence).not.toBe(generic);
  });

  it("the new review refusals are named", () => {
    for (const code of ["player_previously_removed", "player_previously_declined", "expected_share_required", "invite_not_found"]) {
      expect(PLAYERS_REFUSAL[code]).toBeTruthy();
    }
  });

  it("share_changed names the new figure and asks again", () => {
    expect(playersRefusal(refusal(409, { error: "share_changed", share_credits: 30 })))
      .toBe("Your share is now 30.00 cr. Check it and say yes again if you're happy.");
  });

  it("insufficient_balance says what is needed, what can be spent, and the gap", () => {
    expect(playersRefusal(refusal(402, { error: "insufficient_balance", current_credits: 10, required_credits: 25 })))
      .toBe("You need 25.00 cr and have 10.00 cr to spend. Top up 15.00 cr and try again.");
  });

  it("player_invite_limit carries the limit", () => {
    expect(playersRefusal(refusal(409, { error: "player_invite_limit", limit: 8, invites_made: 8 })))
      .toContain("A booking can send 8 invites in all");
  });

  it("partner_cap_exceeded names the cap it would break", () => {
    expect(playersRefusal(refusal(409, { error: "partner_cap_exceeded", cap: "minutes", cap_minutes: 90, club_day: "2026-09-30" })))
      .toBe("Saying yes would take you past your limit of 90 minutes on court a day on Wed 30 Sep.");
    expect(playersRefusal(refusal(409, { error: "partner_cap_exceeded", cap: "slots", cap_slots: 2 })))
      .toBe("Saying yes would take you past your limit of 2 slots a day that day.");
  });

  it("nudge_limit and withdraw_window_closed carry their times in the club's clock", () => {
    const nudge = playersRefusal(refusal(429, { error: "nudge_limit", limit: 2, retry_after: "2026-09-30T16:00:00Z" }), { timezone: "Africa/Johannesburg" });
    expect(nudge).toBe("You've sent 2 reminders today. You can remind them again after Wed 30 Sep, 18:00.");
    const withdraw = playersRefusal(refusal(409, { error: "withdraw_window_closed", closed_at: "2026-09-30T14:00:00Z" }), { timezone: "Africa/Johannesburg" });
    expect(withdraw).toContain("that closed at Wed 30 Sep, 16:00");
  });

  it("directory_rate_limited says how long to wait", () => {
    expect(playersRefusal(refusal(429, { error: "directory_rate_limited", retry_after_seconds: 1 })))
      .toBe("That's a lot of searching — try again in 1 second.");
  });

  it("a failure that is not a refusal is described as what it is, with the action", () => {
    expect(playersRefusal(new NetworkError("unreachable"), { action: "accept the invite" })).toMatch(/^Couldn't accept the invite/);
  });
});

describe("names", () => {
  it("first names only, and a list reads as English", () => {
    expect(firstName("Sam Petersen")).toBe("Sam");
    expect(firstName("  ")).toBe("A member");
    expect(listNames(["Sam"])).toBe("Sam");
    expect(listNames(["Sam", "Alex"])).toBe("Sam and Alex");
    expect(listNames(["Sam", "Alex", "Jo"])).toBe("Sam, Alex and Jo");
  });
});

describe("held credits (§3a)", () => {
  it("a frame with nothing held is all spendable, whatever an older API left out", () => {
    expect(heldFrom({ balance_credits: 80 })).toEqual({ held: 0, owedBack: 0, spendable: 80, until: null });
    expect(heldFrom({ balance_credits: 80, held_credits: 0, spendable_credits: 80, held_until: null })).toEqual({ held: 0, owedBack: 0, spendable: 80, until: null });
  });

  it("the server's spendable figure is taken as given", () => {
    expect(heldFrom({ balance_credits: 120, held_credits: 20, spendable_credits: 100, held_until: "2026-10-02T18:45:00Z" }))
      .toEqual({ held: 20, owedBack: 0, spendable: 100, until: "2026-10-02T18:45:00Z" });
  });

  it("owed back (P11) is its own figure, with no release date, and spendable may go negative", () => {
    expect(heldFrom({ balance_credits: 10, held_credits: 0, owed_back_credits: 16, spendable_credits: -6, held_until: null }))
      .toEqual({ held: 0, owedBack: 16, spendable: -6, until: null });
    // An API that sends owed back but no spendable figure: balance − held − owed back.
    expect(heldFrom({ balance_credits: 50, held_credits: 20, owed_back_credits: 16, held_until: "2026-10-02T18:45:00Z" }))
      .toEqual({ held: 20, owedBack: 16, spendable: 14, until: "2026-10-02T18:45:00Z" });
  });

  it("the owed-back line and its explainer say what it is and what pays it", () => {
    expect(owedBackLine(16)).toBe("16.00 cr owed back to partners — paid from your next credit");
    expect(OWED_BACK_EXPLAINER).toMatch(/next credits you get go to them first/);
    expect(owedBackQuoteLine(16, "Naledi")).toBe("Naledi owes 16.00 cr back to partners — that comes out of the next credit first.");
    expect(owedBackQuoteLine(16, null)).toBe("You owe 16.00 cr back to partners — that comes out of the next credit first.");
  });

  it("the held line names the figure and the release", () => {
    expect(heldLine(20, "2026-10-02T18:45:00Z", "Africa/Johannesburg")).toBe("20.00 cr held until Fri 2 Oct, 20:45");
    expect(heldLine(20, null)).toBe("20.00 cr held");
  });

  it("an invite's balance-after is built on SPENDABLE, never on the raw balance", () => {
    const money = inviteMoney({ balance_credits: 120, spendable_credits: 30, held_credits: 90, to_pay_credits: 25 });
    expect(money).toEqual({ spendable: 30, toPay: 25, after: 5, shortBy: 0, held: 90, owedBack: 0 });
    const short = inviteMoney({ balance_credits: 120, spendable_credits: 10, held_credits: 110, to_pay_credits: 25 });
    expect(short.shortBy).toBe(15);
    // An older API with no spendable figure: the balance less what is held.
    expect(inviteMoney({ balance_credits: 120, held_credits: 100, to_pay_credits: 25 }).after).toBe(-5);
    // P11: what is owed back comes off too, and a negative spendable makes the shortfall bigger.
    expect(inviteMoney({ balance_credits: 30, held_credits: 0, owed_back_credits: 16, to_pay_credits: 25 }))
      .toEqual({ spendable: 14, toPay: 25, after: -11, shortBy: 11, held: 0, owedBack: 16 });
    expect(inviteMoney({ balance_credits: 10, spendable_credits: -6, held_credits: 0, owed_back_credits: 16, to_pay_credits: 25 }).shortBy).toBe(31);
  });
});

describe("the wallet stream carries the bell's count and the held figures", () => {
  const WHOAMI = {
    tenant_slug: "crusaders", tenant_id: "00000000-0000-0000-0000-0000000000cc",
    user_id: "44444444-4444-4444-4444-444444444444", is_authenticated: true, is_admin: false,
  };

  function Probe() {
    const { balance, held, unreadCount } = useBalance();
    return (
      <>
        <span data-testid="balance">{balance === null ? "none" : balance.toFixed(2)}</span>
        <span data-testid="spendable">{held ? held.spendable.toFixed(2) : "none"}</span>
        <span data-testid="held">{held ? held.held.toFixed(2) : "none"}</span>
        <span data-testid="owed">{held ? held.owedBack.toFixed(2) : "none"}</span>
        <span data-testid="unread">{unreadCount === null ? "none" : String(unreadCount)}</span>
      </>
    );
  }

  it("a named notification frame sets the unread count; a balance frame sets the held figures", async () => {
    let live: { onFrame: (f: BalanceFrame) => void; onNotification?: (n: number) => void } | null = null;
    const transport: BalanceTransport = {
      open(args) { live = args; return Promise.resolve({ close: () => { live = null; } }); },
    };
    stubFetch([
      { path: "/api/v1/whoami", body: WHOAMI },
      { path: "/api/v1/wallet", body: { balance_credits: 120, held_credits: 20, spendable_credits: 100, held_until: null, entries: [], total_entries: 0, offset: 0, limit: 100 } },
    ]);
    signIn({ isAdmin: false });
    render(
      <MemoryRouter>
        <AuthProvider>
          <BalanceProvider transport={transport} policy={LIVE_BALANCE_POLICY}>
            <Probe />
          </BalanceProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    await act(async () => {});
    expect(screen.getByTestId("spendable").textContent).toBe("100.00");
    expect(screen.getByTestId("unread").textContent).toBe("none");

    await act(async () => { live?.onNotification?.(3); });
    expect(screen.getByTestId("unread").textContent).toBe("3");

    await act(async () => { live?.onFrame({ balance_credits: 145, held_credits: 45, spendable_credits: 100, held_until: "2026-10-02T18:45:00Z" }); });
    expect(screen.getByTestId("balance").textContent).toBe("145.00");
    expect(screen.getByTestId("held").textContent).toBe("45.00");
    expect(screen.getByTestId("spendable").textContent).toBe("100.00");
    expect(screen.getByTestId("owed").textContent).toBe("0.00");

    // P11: the named balance frame carries owed back, and spendable can go below zero.
    await act(async () => { live?.onFrame({ balance_credits: 10, held_credits: 0, owed_back_credits: 16, spendable_credits: -6, held_until: null }); });
    expect(screen.getByTestId("owed").textContent).toBe("16.00");
    expect(screen.getByTestId("spendable").textContent).toBe("-6.00");
  });
});
