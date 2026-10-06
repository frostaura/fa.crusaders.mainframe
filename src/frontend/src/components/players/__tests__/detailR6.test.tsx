import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { DETAIL_MONEY, DETAIL_NO_SHOW } from "@/lib/playersCopy";
import { BOOKING_STATUS } from "@/lib/memberDetailCopy";
import { minutesCompact, minutesSpoken } from "@/lib/minutes";
import { detail, renderDetail, seat, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * Review round 6 (BE → FB asks): the booking page after somebody else paid for the court at the
 * box (E6-2, D10), and a no-show refunded in full because the box was offline (E6-6) — which is
 * not held against the member anywhere they or an admin look.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const fig = (n: number) => `${minutesCompact(n)}${minutesSpoken(n)}`;
const money = () => document.querySelector<HTMLElement>("[data-money-panel]") as HTMLElement;
function figure(term: string): string | null {
  // R19 L19-3 — the paint glues figures to their units; compared as words.
  return within(money()).getByText(term).parentElement?.querySelector("dd")?.textContent?.replace(/\u00a0/g, " ") ?? null;
}

describe("E6-2 — paid for at the court box by somebody else", () => {
  it("says who paid, that the booker was refunded, and a cost of nothing", async () => {
    serve({ detail: detail({
      players: [seat()],
      money: {
        price_minutes: 30, organiser_owed_minutes: 0, shares_received_minutes: 0, organiser_net_minutes: 0,
        unpaid_minutes: 0, share_deadline: "2026-10-02T18:45:00Z", is_split: false,
        paid_by: { user_id: "u-bea", name: "Bea Payer", photo_url: null }, paid_by_minutes: 30,
      },
    }) });
    renderDetail();
    expect(await screen.findByText(DETAIL_MONEY.paidAtBoxNote("Bea Payer", null, minutesSpoken(30)))).toBeInTheDocument();
    expect(figure(DETAIL_MONEY.organiserPaid(null))).toBe(fig(30));
    expect(figure(DETAIL_MONEY.refundedAtBox(null))).toBe(fig(30));
    expect(figure(DETAIL_MONEY.net(null))).toBe(fig(0));
    expect(money()).not.toHaveTextContent(/paid at booking30 min30 minutesYour cost30/);
  });
});

describe("E6-6 — a no-show refunded because the box was offline", () => {
  it("says it was refunded in full and is not a no-show", async () => {
    serve({ detail: detail({
      status: "no_show", refunded_for_outage: true, players: [seat()],
      money: {
        price_minutes: 45, organiser_owed_minutes: 0, shares_received_minutes: 0, organiser_net_minutes: 0,
        unpaid_minutes: 0, share_deadline: "2026-10-02T18:45:00Z", is_split: false, refunded_minutes: 45, penalty_minutes: 0,
      },
    }) });
    renderDetail();
    expect(await screen.findByText(DETAIL_NO_SHOW.outageNote)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/no-show penalty|Nobody checked in, so the court was refunded less/);
  });

  it("the admin's bookings list has a word for it that is not 'No-show'", () => {
    expect(BOOKING_STATUS.refunded_outage.word).not.toMatch(/no-show/i);
    expect(BOOKING_STATUS.refunded_outage.tone).toBe("neutral");
  });
});
