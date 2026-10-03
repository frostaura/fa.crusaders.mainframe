import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import InvitesPage from "@/pages/Invites";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { INVITES_COPY } from "@/lib/playersCopy";

/**
 * R8 X8-5 — an accept refused with 402 `insufficient_balance` (the wallet moved since the sheet
 * read it: an admin took minutes) left the header chip at the old "30 min" while the sheet said
 * the member had 0. The refusal is the club saying the wallet on this phone is stale: it is read
 * again, so the chip says what the sheet does.
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
  balance_minutes: 30, spendable_minutes: 30, held_minutes: 0, balance_after_minutes: 5, short_by_minutes: 0,
  share_deadline: at(26.75), cap: null,
};

describe("X8-5 — a 402 on Accept re-reads the wallet", () => {
  it("asks for the wallet again, so the chip follows the club's figure", async () => {
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", sequence: [
        { balance_minutes: 30, held_minutes: 0, spendable_minutes: 30, held_until: null, entries: [], total_entries: 0, offset: 0, limit: 10 },
        { balance_minutes: 0, held_minutes: 0, spendable_minutes: 0, held_until: null, entries: [], total_entries: 0, offset: 0, limit: 10 },
      ] },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
      { path: "/api/v1/me/invites", body: { items: [invite], count: 1 } },
      { method: "POST", path: ACCEPT, status: 402, body: { error: "insufficient_balance", current_minutes: 0, required_minutes: 25 } },
    ]);
    renderPage(<InvitesPage />, { initialEntries: ["/bookings/invites"] });
    fireEvent.click(await screen.findByRole("button", { name: /Sam invited you to play/ }));
    const sheet = await screen.findByRole("dialog", { name: INVITES_COPY.sheetTitle });
    const wallets = () => stub.calls.filter((c) => c.method === "GET" && c.path.split("?")[0] === "/api/v1/wallet").length;
    const before = wallets();
    fireEvent.click(within(sheet).getByRole("button", { name: /^(Accept|Say yes)/ }));
    await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.path === ACCEPT)).toBe(true));
    await waitFor(() => expect(wallets()).toBeGreaterThan(before));
  });
});
