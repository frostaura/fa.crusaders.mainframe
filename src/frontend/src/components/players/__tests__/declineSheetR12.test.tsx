import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import InvitesPage from "@/pages/Invites";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { INVITES_COPY } from "@/lib/playersCopy";

/**
 * R12 J12-3 — the Decline question was still titled "Join this game?" and still showed the share,
 * the balance after, the daily-limit warning and the pay-by deadline: figures for an answer the
 * member is not giving. Asking "decline for good?", the sheet is titled for it, draws none of the
 * money, and says plainly that nothing moves. Keeping the invite brings all of it back.
 */
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { vi.unstubAllGlobals(); signOut(); window.localStorage.clear(); });

const BOOKING = "b0000000-0000-0000-0000-000000000001";
const SEAT = "p0000000-0000-0000-0000-000000000003";
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const invite = {
  participant_id: SEAT, booking_id: BOOKING, status: "invited", seat: 3, team: "B", open_link: false,
  court_name: "Court 1", starts_at: at(24), ends_at: at(24.75),
  organiser: { user_id: "55555555-5555-5555-5555-555555555555", name: "Sam Petersen", photo_url: null },
  players: 4, share_minutes: 25, to_pay_minutes: 25, needs_consent: false,
  balance_minutes: 120, spendable_minutes: 100, held_minutes: 20, balance_after_minutes: 75, short_by_minutes: 0,
  share_deadline: at(26.75),
  cap: { cap: "minutes", cap_minutes: 60, already_booked_minutes: 45, attempted_minutes: 25, club_day: "2030-09-10" },
};

async function openSheet() {
  stubFetch([
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/wallet", body: {
      balance_minutes: 120, held_minutes: 20, spendable_minutes: 100, held_until: at(30), held_parts: [],
      entries: [], total_entries: 0, offset: 0, limit: 10,
    } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    { path: "/api/v1/me/invites", body: { items: [invite], count: 1 } },
  ]);
  renderPage(<InvitesPage />, { initialEntries: ["/bookings/invites"] });
  fireEvent.click(await screen.findByRole("button", { name: /Sam invited you to play/ }));
  return screen.findByRole("dialog", { name: INVITES_COPY.sheetTitle });
}

describe("R12 J12-3 — the Decline question is about declining", () => {
  it("titled for it, no money, no limit, no deadline — and says nothing moves", async () => {
    const sheet = await openSheet();
    expect(sheet.querySelector("[data-money]")).not.toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: INVITES_COPY.decline }));
    expect(screen.getByRole("dialog", { name: INVITES_COPY.declineSheetTitle })).toBe(sheet);
    expect(within(sheet).queryByRole("heading", { name: INVITES_COPY.sheetTitle })).toBeNull();
    for (const sel of ["[data-money]", "[data-held]", "[data-cap]", "[data-cap-counts]", "[data-deadline]", "[data-short]"]) {
      expect(sheet.querySelector(sel), sel).toBeNull();
    }
    expect(within(sheet).queryByText(INVITES_COPY.yourShare)).toBeNull();
    // One announcement: the final-and-nothing-moves sentence is a single live region.
    const final = sheet.querySelector("[data-decline-final]");
    expect(final?.textContent).toContain(INVITES_COPY.declineFinal("Sam"));
    expect(final?.textContent).toContain(INVITES_COPY.declineNothingMoves);
    expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: INVITES_COPY.declineKeep }));
  });

  it("keeping the invite brings the share and the title back, focus on Decline", async () => {
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: INVITES_COPY.decline }));
    fireEvent.click(within(sheet).getByRole("button", { name: INVITES_COPY.declineKeep }));
    expect(screen.getByRole("dialog", { name: INVITES_COPY.sheetTitle })).toBe(sheet);
    expect(sheet.querySelector("[data-money]")).not.toBeNull();
    expect(sheet.querySelector("[data-deadline]")).not.toBeNull();
    expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: INVITES_COPY.decline }));
  });
});
