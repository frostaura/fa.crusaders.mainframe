import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { InviteCard } from "@/components/players/invites/InviteCard";
import type { Invite, MemberNotification } from "@/lib/playersApi";
import { INBOX_COPY } from "@/lib/playersCopy";
import { resetUnread } from "@/components/inbox/useUnreadCount";
import { BalanceProvider } from "@/lib/balance";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import WalletPage from "./Wallet";
import WalletActivityPage, { ACTIVITY_COPY } from "./WalletActivity";
import InboxPage from "./Inbox";

/**
 * R19 L19-3 — a figure is never split from its unit when the line wraps: "· 3 / players" and "Your
 * share 10 / min" on an invite card, "9 h 10 / min" on the wallet's figure, "+1 h 30 / min" in the
 * activity's net sentence, "15 / minutes" in an inbox notice. The paint glues each figure to the
 * word after it with a no-break space (`keepFiguresWhole`); what a reader hears is unchanged.
 */

const NBSP = "\u00a0";
/** A digit, an ORDINARY space, then a letter: a place the line may break between a figure and its unit. */
const SPLITTABLE = /\d [\p{L}]/u;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); signOut(); resetUnread(); localStorage.clear(); });

function at(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
}

const INVITE = {
  participant_id: "p0000000-0000-0000-0000-000000000003", booking_id: "b0000000-0000-0000-0000-000000000001",
  status: "invited", seat: 3, team: "B", open_link: false, court_name: "Court 1", starts_at: at(24), ends_at: at(24.75),
  organiser: { user_id: "55555555-5555-5555-5555-555555555555", name: "Sam Petersen", photo_url: null },
  players: 3, share_minutes: 10, to_pay_minutes: 10, needs_consent: false,
  balance_minutes: 120, spendable_minutes: 100, held_minutes: 20, balance_after_minutes: 110, short_by_minutes: 0,
  share_deadline: at(26.75), cap: null,
} as Invite;

/** Painted (not screen-reader-only) text under `root`. */
function painted(root: Element): string {
  const clone = root.cloneNode(true) as Element;
  clone.querySelectorAll(".sr-only").forEach((n) => n.remove());
  return clone.textContent ?? "";
}

describe("figures stay whole (R19 L19-3)", () => {
  it("invite card: '· 3 players' and 'Your share 10 min' never split figure from unit", () => {
    renderPage(<InviteCard invite={INVITE} onOpen={() => undefined} />);
    const card = document.querySelector(`[data-invite="${INVITE.participant_id}"]`)!;
    const text = painted(card);
    expect(text).toContain(`3${NBSP}players`);
    expect(text).toContain(`10${NBSP}min`);
    expect(text).not.toMatch(/\d [\p{L}]/u);
  });

  describe("the wallet", () => {
    beforeEach(() => {
      vi.stubGlobal("EventSource", class { close() {} } as unknown as typeof EventSource);
      vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
        matches: query.includes("reduce"), media: query, onchange: null,
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList);
    });

    it("the big figure: '9 h 10 min' is glued figure by figure", async () => {
      stubFetch([
        { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
        { path: "/api/v1/wallet", body: { balance_minutes: 550, entries: [], total_entries: 0, offset: 0, limit: 100 } },
        { path: "/api/v1/schedule", body: { date: "2026-10-03", timezone: "Africa/Johannesburg", sliceMinutes: 15, courts: [] } },
      ]);
      renderPage(<BalanceProvider><WalletPage /></BalanceProvider>, { initialEntries: ["/wallet"] });
      const card = await waitFor(() => {
        const c = document.querySelector("[data-balance-level]");
        expect(c && painted(c)).toMatch(/9.h 10.min/);
        return c!;
      }, { timeout: 10_000 });
      expect(painted(card)).toContain(`9${NBSP}h 10${NBSP}min`);
      // Heard in words, unchanged.
      expect(within(card as HTMLElement).getByText("9 hours 10 minutes")).toBeInTheDocument();
    });

    it("activity: the net sentence's '+1 h 30 min' and every total are glued", async () => {
      stubFetch([
        { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
        {
          path: "/api/v1/reports/me/wallet",
          body: {
            from: "2026-09-01", to: "2026-09-30", top_ups_minutes: 600, spent_minutes: 135, refunds_minutes: 45, penalties_minutes: 15,
            adjustments_minutes: 0, reversals_minutes: 0, share_transfers_minutes: -30, net_court_spend_minutes: 135, net_movement_minutes: 90,
            penalty_count: 1, attended_bookings: 3, minutes_on_court: 135, count: 7,
          },
        },
        { path: "/api/v1/reports/me/daily", body: [] },
      ]);
      renderPage(<WalletActivityPage />);
      const help = await screen.findByText(ACTIVITY_COPY.totalsHelp, {}, { timeout: 10_000 });
      const totals = help.closest("section") as HTMLElement;
      const text = painted(totals);
      expect(text).toContain(`+1${NBSP}h 30${NBSP}min`);
      expect(text).not.toMatch(SPLITTABLE);
    }, 20_000);
  });

  it("inbox: '15 minutes' in a notice's words is glued in the list; its link keeps the plain name", async () => {
    const headline = "Sam paid you 15 minutes for their share of Court 1 · Wed 30 Sep";
    const item: MemberNotification = {
      id: "n1", kind: "players.share_moved", headline, link: null, booking_id: "b1", created_at: new Date().toISOString(), read_at: null,
    };
    const linked: MemberNotification = { ...item, id: "n2", link: "/bookings/b1", headline: "Alex paid their 25 minutes share" };
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", body: { balance_minutes: 100, entries: [], total_entries: 0, offset: 0, limit: 100 } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
      { path: "/api/v1/me/notifications/unread-count", body: { unread_count: 2 } },
      { path: "/api/v1/me/notifications", body: { items: [item, linked], unread_count: 2, next_cursor: null } },
    ]);
    renderPage(<Routes><Route path="/inbox" element={<InboxPage />} /></Routes>, { initialEntries: ["/inbox"] });
    const list = await screen.findByRole("list", { name: INBOX_COPY.listLabel }, { timeout: 10_000 });
    const text = painted(list);
    expect(text).toContain(`15${NBSP}minutes`);
    expect(text).toContain(`30${NBSP}Sep`);
    expect(text).not.toMatch(SPLITTABLE);
    // The row that opens somewhere is still named by the notice's words, as written.
    expect(within(list).getByRole("link", { name: "Alex paid their 25 minutes share" })).toBeInTheDocument();
  });
});
