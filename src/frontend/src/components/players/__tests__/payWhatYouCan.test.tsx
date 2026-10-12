import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import InvitesPage from "@/pages/Invites";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { acceptBody, payWhatYouCan } from "@/lib/playersApi";
import { INVITES_COPY, partPaidLine, payPartLabel } from "@/lib/playersCopy";

/**
 * Pay what you can — the partner's side (players-and-splits.md §4). Short of a 25-minute share
 * with 15 to spend, the sheet offers "Pay the 15 minutes I have" beside Buy minutes; it accepts with
 * `payMinutes`, and the outcome says what was paid and that the rest is with the organiser.
 */
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { vi.unstubAllGlobals(); signOut(); window.localStorage.clear(); });

const BOOKING = "b0000000-0000-0000-0000-000000000001";
const SEAT = "p0000000-0000-0000-0000-000000000003";
const ACCEPT = `/api/v1/bookings/${BOOKING}/players/${SEAT}/accept`;
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const invite = {
  participant_id: SEAT, booking_id: BOOKING, status: "invited", seat: 3, team: "B", open_link: false,
  court_name: "Court 1", starts_at: at(24), ends_at: at(24.75),
  organiser: { user_id: "55555555-5555-5555-5555-555555555555", name: "Sam Petersen", photo_url: null },
  players: 4, share_minutes: 25, to_pay_minutes: 25, needs_consent: false,
  balance_minutes: 15, spendable_minutes: 15, held_minutes: 0, balance_after_minutes: -10, short_by_minutes: 10,
  share_deadline: at(26.75), cap: null,
};
const wallet = (m: number) => ({ balance_minutes: m, held_minutes: 0, spendable_minutes: m, held_until: null, entries: [], total_entries: 0, offset: 0, limit: 10 });

function serve(theInvite: typeof invite) {
  return stubFetch([
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/wallet", body: null, sequence: [wallet(theInvite.spendable_minutes), wallet(0)] },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    { path: "/api/v1/me/invites", body: { items: [theInvite], count: 1 } },
    { method: "POST", path: ACCEPT, body: {
      participant_id: SEAT, booking_id: BOOKING, status: "accepted", share_minutes: 15, consented_minutes: 15, paid_minutes: 15,
      balance_minutes: 0, spendable_minutes: 0, held_minutes: 0,
    } },
  ]);
}

async function openSheet() {
  renderPage(<InvitesPage />, { initialEntries: ["/bookings/invites"] });
  fireEvent.click(await screen.findByRole("button", { name: /Sam invited you to play/ }));
  return screen.findByRole("dialog", { name: INVITES_COPY.sheetTitle });
}

describe("pay what you can — the figure", () => {
  it("is everything spendable on top of what was paid, only when that is part of the share", () => {
    expect(payWhatYouCan(25, 25, 15)).toBe(15);
    expect(payWhatYouCan(25, 15, 5)).toBe(15);       // 10 paid already, 5 more to spend
    expect(payWhatYouCan(25, 25, 0)).toBeNull();     // nothing to spend
    expect(payWhatYouCan(25, 25, -3)).toBeNull();
    expect(payWhatYouCan(25, 25, 25)).toBeNull();    // the whole share: a plain accept
    expect(payWhatYouCan(25, 25, 7.9)).toBe(7);      // whole minutes only
  });

  it("names payMinutes on the wire only when there is a part", () => {
    expect(acceptBody(25)).toEqual({ expectedShareMinutes: 25 });
    expect(acceptBody(25, 15)).toEqual({ expectedShareMinutes: 25, payMinutes: 15 });
  });
});

describe("pay what you can — the accept sheet", () => {
  it("offers the minutes they have beside Buy minutes, accepts with payMinutes, and says the rest is with the organiser", async () => {
    const stub = serve(invite);
    const sheet = await openSheet();
    const short = await waitFor(() => {
      const found = sheet.querySelector("[data-short]");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(within(short).getByRole("link", { name: INVITES_COPY.buyMinutes })).toBeInTheDocument();
    expect(within(short).getByText(INVITES_COPY.payPartBody)).toBeInTheDocument();
    fireEvent.click(within(short).getByRole("button", { name: payPartLabel(15) }));

    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.path === ACCEPT)).toBe(true));
    expect(stub.calls.find((c) => c.method === "POST" && c.path === ACCEPT)?.body).toEqual({ expectedShareMinutes: 25, payMinutes: 15 });
    const outcome = await waitFor(() => {
      const found = sheet.querySelector("[data-outcome='accepted']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(outcome).toHaveTextContent(partPaidLine(15, "Sam", 10));
    expect(outcome.textContent).not.toMatch(/credit/i);
  });

  it("offers no part to a member with nothing to spend", async () => {
    serve({ ...invite, balance_minutes: 0, spendable_minutes: 0, balance_after_minutes: -25, short_by_minutes: 25 });
    const sheet = await openSheet();
    await waitFor(() => expect(sheet.querySelector("[data-short]")).not.toBeNull());
    expect(sheet.querySelector("[data-pay-part]")).toBeNull();
    expect(sheet.querySelector("[data-pay-part-body]")).toBeNull();
  });
});
