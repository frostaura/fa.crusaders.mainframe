import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { INVITES_COPY } from "@/lib/playersCopy";
import { renderPage, signIn, signOut } from "@/test/harness";
import InvitesPage from "@/pages/Invites";
import { memberReads, type WalletActivity } from "./memberReads";
import { OFFLINE_COPY, asOfLabel } from "./offlineCopy";
import { peekQuery, primeQuery, setDataOwner } from "./queryCache";
import { useKeptReport } from "./useKeptReport";

/**
 * R5 M5-6 — /bookings/invites and /wallet/activity were dead offline ("Can't reach the club")
 * while the pages around them drew from the phone. Their reads are kept by `lib/offline` now:
 * with no signal they draw what the club last said, with its time. (Which routes RENDER offline
 * is `RequireAuth`'s list; these hold the data side.)
 */

const ANA = "44444444-4444-4444-4444-444444444444";
const LAST_IDENTITY_KEY = "crusaders.mainframe.last-identity";
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  signOut();
  localStorage.clear();
});

function offlinePhone() {
  signIn({ isAdmin: false });
  localStorage.setItem(LAST_IDENTITY_KEY, ANA);
  setDataOwner(ANA);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
}

const INVITE = {
  participant_id: "p0000000-0000-0000-0000-000000000003", booking_id: "b0000000-0000-0000-0000-000000000001",
  status: "invited", seat: 3, team: "B", open_link: false, court_name: "Court 1", starts_at: at(24), ends_at: at(24.75),
  organiser: { user_id: "55555555-5555-5555-5555-555555555555", name: "Sam Petersen", photo_url: null },
  players: 4, share_minutes: 25, to_pay_minutes: 25, needs_consent: false,
  balance_minutes: 120, spendable_minutes: 100, held_minutes: 20, balance_after_minutes: 95, short_by_minutes: 0,
  share_deadline: at(26.75), cap: null,
};

describe("kept reads with no signal (R5 M5-6)", () => {
  it("Invites draws the last list from the phone, said as offline with its time — never 'can't reach'", async () => {
    offlinePhone();
    primeQuery(ANA, memberReads.invites.key, { items: [INVITE], count: 1 });
    const keptAt = peekQuery(ANA, memberReads.invites.key)!.at;

    renderPage(<InvitesPage />, { initialEntries: ["/bookings/invites"] });

    const list = await screen.findByRole("list", { name: INVITES_COPY.listLabel }, { timeout: 3000 });
    expect(within(list).getByRole("button", { name: /Sam invited you to play/ })).toBeInTheDocument();
    const note = (await screen.findByText(OFFLINE_COPY.staleTitle)).closest("[data-stale-notice]");
    expect(note).toHaveTextContent(`showing what we had at ${asOfLabel(keptAt)}`);
    expect(screen.queryByText(/couldn't be reached/i)).toBeNull();
  });

  it("Wallet activity's range is drawn from the phone, with its time", async () => {
    offlinePhone();
    const markers = { from: "2026-09-01T00:00:00+02:00", to: "2026-10-01T00:00:00+02:00" };
    const kept: WalletActivity = { wallet: { topups_credits: 200 } as unknown as WalletActivity["wallet"], days: [] };
    primeQuery(ANA, memberReads.walletActivity(markers).key, kept);
    function Probe() {
      const report = useKeptReport(memberReads.walletActivity(markers));
      return <p data-testid="probe">{`${report.data ? "drawn" : "none"}|${report.stale}|${report.offline}`}</p>;
    }

    renderPage(<Probe />, { initialEntries: ["/wallet/activity"] });

    expect(await screen.findByText("drawn|true|true")).toBeInTheDocument();
  });
});
