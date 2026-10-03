import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import InvitesPage from "@/pages/Invites";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { INVITES_COPY } from "@/lib/playersCopy";

/**
 * R9 X9-5 — an accept refused with 402 `insufficient_balance` re-reads the invite; the fresh read
 * says the member is short, and the sheet's own short notice ("You need … more" + Buy minutes) is
 * the answer. The red refusal stayed above it: the same thing said twice, with two Buy minutes.
 * Once the sheet is short the refusal is dropped; a 402 the re-read does NOT explain still shows.
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
const shortInvite = { ...invite, balance_minutes: 0, spendable_minutes: 0, balance_after_minutes: -25, short_by_minutes: 25 };
const wallet = (m: number) => ({ balance_minutes: m, held_minutes: 0, spendable_minutes: m, held_until: null, entries: [], total_entries: 0, offset: 0, limit: 10 });

async function acceptRefused(reread: unknown) {
  const stub = stubFetch([
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/wallet", body: null, sequence: [wallet(30), wallet(0)] },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    { path: "/api/v1/me/invites", body: null, sequence: [{ items: [invite], count: 1 }, { items: [reread], count: 1 }] },
    { method: "POST", path: ACCEPT, status: 402, body: { error: "insufficient_balance", current_minutes: 0, required_minutes: 25 } },
  ]);
  renderPage(<InvitesPage />, { initialEntries: ["/bookings/invites"] });
  fireEvent.click(await screen.findByRole("button", { name: /Sam invited you to play/ }));
  const sheet = await screen.findByRole("dialog", { name: INVITES_COPY.sheetTitle });
  fireEvent.click(within(sheet).getByRole("button", { name: /^(Accept|Say yes)/ }));
  await waitFor(() => expect(stub.calls.some((c) => c.method === "POST" && c.path === ACCEPT)).toBe(true));
  return sheet;
}

describe("X9-5 — a 402 then a short sheet says it once", () => {
  it("drops the red refusal once the re-read shows the member short: one notice, one Buy minutes", async () => {
    const sheet = await acceptRefused(shortInvite);
    await waitFor(() => expect(sheet.querySelector("[data-short]")).not.toBeNull());
    expect(within(sheet).queryByRole("alert")).toBeNull();
    expect(within(sheet).getAllByRole("link", { name: INVITES_COPY.buyMinutes })).toHaveLength(1);
  });

  it("keeps the refusal when the re-read does not explain it (not short)", async () => {
    const sheet = await acceptRefused(invite);
    await waitFor(() => expect(within(sheet).getByRole("alert")).toBeInTheDocument());
    expect(sheet.querySelector("[data-short]")).toBeNull();
    expect(within(sheet).getAllByRole("link", { name: INVITES_COPY.buyMinutes })).toHaveLength(1);
  });
});
