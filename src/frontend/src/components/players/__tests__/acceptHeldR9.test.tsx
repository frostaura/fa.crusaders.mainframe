import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import InvitesPage from "@/pages/Invites";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { INVITES_COPY } from "@/lib/playersCopy";
import { minutesSpoken } from "@/lib/minutes";

/**
 * R9 J9-2 (member half) — the accept sheet said "30 minutes held until Tue 6 Oct" when 15 of it
 * stays until Wed: with shares from two games held, the total takes no date and each part is
 * listed with its own, as the Wallet does. And its last figure is what may be SPENT after a yes,
 * so with anything held it is "Available after", beside "Available now" — the Book sheet's words.
 */
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { vi.unstubAllGlobals(); signOut(); window.localStorage.clear(); });

const BOOKING = "b0000000-0000-0000-0000-000000000001";
const SEAT = "p0000000-0000-0000-0000-000000000003";
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const invite = (held: number) => ({
  participant_id: SEAT, booking_id: BOOKING, status: "invited", seat: 3, team: "B", open_link: false,
  court_name: "Court 1", starts_at: at(24), ends_at: at(24.75),
  organiser: { user_id: "55555555-5555-5555-5555-555555555555", name: "Sam Petersen", photo_url: null },
  players: 4, share_minutes: 25, to_pay_minutes: 25, needs_consent: false,
  balance_minutes: 120, spendable_minutes: 120 - held, held_minutes: held, balance_after_minutes: 95 - held, short_by_minutes: 0,
  share_deadline: at(26.75), cap: null,
});

async function openSheet(held: number, parts: { minutes: number; until: string }[]) {
  stubFetch([
    { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
    { path: "/api/v1/wallet", body: {
      balance_minutes: 120, held_minutes: held, spendable_minutes: 120 - held, held_until: parts.at(-1)?.until ?? null, held_parts: parts,
      entries: [], total_entries: 0, offset: 0, limit: 10,
    } },
    { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
    { path: "/api/v1/me/invites", body: { items: [invite(held)], count: 1 } },
  ]);
  renderPage(<InvitesPage />, { initialEntries: ["/bookings/invites"] });
  fireEvent.click(await screen.findByRole("button", { name: /Sam invited you to play/ }));
  return screen.findByRole("dialog", { name: INVITES_COPY.sheetTitle });
}

describe("J9-2 — the accept sheet's held minutes and its last figure", () => {
  it("held in two parts: no one date for the total, each part with its own; figures named Available now / after", async () => {
    const sheet = await openSheet(30, [{ minutes: 15, until: at(30) }, { minutes: 15, until: at(54) }]);
    const held = await within(sheet).findByText(`${minutesSpoken(30)} held`);
    expect(held).toBeInTheDocument();
    expect(sheet.querySelector("[data-held-parts]")?.textContent).toMatch(new RegExp(`${minutesSpoken(15)} until .* · ${minutesSpoken(15)} until `));
    expect(within(sheet).getByText(INVITES_COPY.availableNow)).toBeInTheDocument();
    expect(within(sheet).getByText(INVITES_COPY.availableAfter)).toBeInTheDocument();
    expect(within(sheet).queryByText(INVITES_COPY.balanceAfter)).toBeNull();
  });

  it("nothing held: the balance's own words", async () => {
    const sheet = await openSheet(0, []);
    expect(await within(sheet).findByText(INVITES_COPY.balanceAfter)).toBeInTheDocument();
    expect(within(sheet).getByText(INVITES_COPY.balanceNow)).toBeInTheDocument();
    expect(within(sheet).queryByText(INVITES_COPY.availableAfter)).toBeNull();
  });
});
