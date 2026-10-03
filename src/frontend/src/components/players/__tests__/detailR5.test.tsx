import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import BookingDetailPage from "@/pages/BookingDetail";
import { refuse, renderPage, signOut } from "@/test/harness";
import { clubClock } from "@/lib/clubClock";
import type { BookingDetail, MySeat } from "@/lib/playersApi";
import {
  DETAIL_ATTENDANCE, DETAIL_CANCELLED, DETAIL_COPY, DETAIL_GONE, DETAIL_MONEY, DETAIL_NO_SHOW, DETAIL_PLAYER,
} from "@/lib/playersCopy";
import { minutesCompact, minutesSpoken } from "@/lib/minutes";
import { keepAmounts } from "@/components/players/detail/detailModel";
import {
  ALEX, BOOKING, DETAIL_PATH, PID, SAM, SAM_SEAT, STARTS, detail, playerView, renderDetail, seat, serve,
} from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * Review round 5, lane D1 — the booking page: the invitee's answer docked in thumb reach (F5),
 * money that never breaks mid-value (V5-7), a no-show's own money view (M5-3), a late
 * cancellation's penalty said on the page (M5-7), and "You were taken off this game" instead of
 * "Booking not found" (M5-8). Every figure below is the API's own field, as the ledger posted it.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const NBSP = " ";
/** A `<Minutes>` figure's text: the compact form the eye reads, then the words a screen reader hears. */
const fig = (n: number) => `${minutesCompact(n)}${minutesSpoken(n)}`;
const money = () => document.querySelector<HTMLElement>("[data-money-panel]") as HTMLElement;
/** A `dl` row's figure, by its term. */
function figure(term: string): string | null {
  const row = within(money()).getByText(term).parentElement;
  return row?.querySelector("dd")?.textContent ?? null;
}

function wideScreen() {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query.includes("min-width: 1024px"), media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
}

describe("F5 — the invitee's answer is docked in thumb reach on a phone", () => {
  it("phone: Review and Decline sit in the bottom bar, once each", async () => {
    serve({ detail: playerView() });
    renderDetail();
    const bar = await screen.findByRole("region", { name: DETAIL_COPY.answerLabel });
    expect(within(bar).getByRole("link", { name: DETAIL_PLAYER.review })).toHaveAttribute("href", `/invites/${PID.alex}`);
    expect(within(bar).getByRole("button", { name: DETAIL_PLAYER.decline })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: DETAIL_PLAYER.decline })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: DETAIL_PLAYER.review })).toHaveLength(1);
  });

  it("from lg: inline in the share panel, no bar", async () => {
    wideScreen();
    serve({ detail: playerView() });
    renderDetail();
    expect(await screen.findByRole("link", { name: DETAIL_PLAYER.review })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: DETAIL_COPY.answerLabel })).toBeNull();
  });
});

describe("V5-7 — money never wraps mid-value", () => {
  it("a lone figure does not wrap, and every minutes figure in a sentence is held together", async () => {
    serve({ detail: playerView({ players: [seat({ user_id: SAM, name: "Sam Petersen" }), SAM_SEAT, { ...SAM_SEAT, participant_id: PID.alex, seat: 3, user_id: ALEX, name: "Alex Naidoo" }] }) });
    renderDetail();
    await screen.findByText(DETAIL_PLAYER.toPay);
    for (const dd of document.querySelectorAll("dd")) expect(dd.className).toContain("whitespace-nowrap");
    const [line] = within(money()).getAllByText((_, el) => el?.tagName === "SPAN" && /^Paid 25/.test(el.textContent ?? ""));
    expect(line.textContent).toBe(`Paid 25${NBSP}minutes of 25${NBSP}minutes`);
    expect(keepAmounts("Paid 1 h 30 min of 2 d 3 h")).toBe(`Paid 1${NBSP}h${NBSP}30${NBSP}min of 2${NBSP}d${NBSP}3${NBSP}h`);
    expect(keepAmounts("Paid 1 hour 30 minutes of 2 days 3 hours")).toBe(`Paid 1${NBSP}hour${NBSP}30${NBSP}minutes of 2${NBSP}days${NBSP}3${NBSP}hours`);
  });
});

/**
 * Olga's no-show, in whole minutes (P13): a 50 min court, Pieter and Thandi asked 16 each and
 * paid; nobody checked in. The sweep refunded 50 and kept 15 (30 %); each partner's share came
 * down to ⌊15 × 16 ÷ 50⌋ = 4 (rounded down, §1.2), so 12 went back to each, and Olga kept the
 * rest. The sweep truncated ends_at to its own clock.
 */
const SOLD_END = "2026-09-30T16:15:00Z";
const SWEPT_END = "2026-09-30T16:05:00Z";
function partner(pid: string, n: number, name: string) {
  return seat({
    participant_id: pid, seat: n, team: n <= 2 ? "A" : "B", kind: "member", user_id: `u-${n}`, name,
    share_minutes: 16, consented_minutes: 16, paid_minutes: 4, target_minutes: 4, returned_minutes: 12,
  });
}
function noShow(overrides: Partial<BookingDetail> = {}): BookingDetail {
  return detail({
    status: "no_show", ends_at: SWEPT_END, sold_ends_at: SOLD_END,
    players: [seat({ name: "Olga Petrova" }), partner(PID.sam, 2, "Pieter Botha"), partner(PID.alex, 3, "Thandi Third")],
    money: {
      price_minutes: 50, organiser_owed_minutes: 15, shares_received_minutes: 8, organiser_net_minutes: 7,
      unpaid_minutes: 0, share_deadline: "2026-10-02T18:45:00Z", is_split: true,
    },
    permissions: {
      can_invite: false, can_change_split: false, can_cancel: false, can_accept: false, can_decline: false,
      can_withdraw: false, withdraw_closes_at: "2026-09-30T14:00:00Z",
    },
    ...overrides,
  });
}

describe("M5-3 — a no-show has its own money view", () => {
  it("organiser: paid at booking 50, refunded 50, penalty 15, shares 8, cost 7; each partner's 12 back", async () => {
    serve({ detail: noShow() });
    renderDetail();
    await screen.findByText(DETAIL_NO_SHOW.moneyNote(true));
    expect(figure(DETAIL_MONEY.price)).toBe(fig(50));
    expect(figure(DETAIL_MONEY.organiserPaid(null))).toBe(fig(50));
    expect(figure(DETAIL_NO_SHOW.refunded(null))).toBe(fig(50));
    expect(figure(DETAIL_NO_SHOW.penalty)).toBe(fig(-15));
    expect(figure(DETAIL_MONEY.received)).toBe(fig(8));
    expect(figure(DETAIL_MONEY.net(null))).toBe(fig(7));
    // 50 − 50 + 15 − 8 = 7: the rows add up to the total, in whole minutes.
    expect(money()).toHaveTextContent(DETAIL_NO_SHOW.paidBackRow(minutesSpoken(16), minutesSpoken(12)));
    expect(money()).not.toHaveTextContent(DETAIL_MONEY.paidRow(minutesSpoken(4), minutesSpoken(16)));
    expect(money()).not.toHaveTextContent(/Shares close|not paid yet/);
    expect(screen.getByText(DETAIL_NO_SHOW.attendance)).toBeInTheDocument();
    expect(screen.queryByText(DETAIL_ATTENDANCE.notYet)).toBeNull();
  });

  it("the title ends when the slot was sold to end, not when the sweep truncated it", async () => {
    serve({ detail: noShow() });
    renderDetail();
    const title = await screen.findByRole("heading", { level: 1 });
    expect(title).toHaveTextContent(clubClock(SOLD_END));
    expect(title).not.toHaveTextContent(clubClock(SWEPT_END));
  });

  it("a partner: what they paid and what came back — no 'Still to pay', no 'all paid up', no Review", async () => {
    serve({ detail: noShow({ viewer: { role: "player", participant_id: PID.sam }, organiser: { user_id: "u-olga", name: "Olga Petrova", photo_url: null } }) });
    renderDetail();
    await screen.findByText(DETAIL_NO_SHOW.moneyNote(true));
    const own = document.querySelector("[data-no-show-share]");
    expect(own?.textContent).toBe(keepAmounts(DETAIL_NO_SHOW.partnerBack(minutesSpoken(16), minutesSpoken(12), minutesSpoken(4))));
    expect(screen.queryByText(DETAIL_PLAYER.toPay)).toBeNull();
    expect(screen.queryByText(DETAIL_PLAYER.paidAll)).toBeNull();
    expect(screen.queryByRole("link", { name: DETAIL_PLAYER.review })).toBeNull();
    expect(figure(DETAIL_MONEY.organiserPaid("Olga"))).toBe(fig(50));
  });

  it("a waived no-show (the box was dark) says it all came back, with no penalty row", async () => {
    serve({ detail: noShow({
      players: [seat({ name: "Olga Petrova" })],
      money: { price_minutes: 50, organiser_owed_minutes: 0, shares_received_minutes: 0, organiser_net_minutes: 0, unpaid_minutes: 0, share_deadline: STARTS, is_split: false },
    }) });
    renderDetail();
    await screen.findByText(DETAIL_NO_SHOW.moneyNoteFree);
    expect(within(money()).queryByText(DETAIL_NO_SHOW.penalty)).toBeNull();
    expect(figure(DETAIL_MONEY.net(null))).toBe(fig(0));
  });
});

const CANCELLED_PERMISSIONS = {
  can_invite: false, can_change_split: false, can_cancel: false, can_accept: false, can_decline: false,
  can_withdraw: false, withdraw_closes_at: "2026-09-30T14:00:00Z",
};

describe("M5-7 — a late cancellation says its penalty on the page", () => {
  it("not split: refunded 50 and the 15 penalty, as the ledger's two rows; cost 15", async () => {
    serve({ detail: detail({
      status: "cancelled", players: [seat()], permissions: CANCELLED_PERMISSIONS,
      money: { price_minutes: 50, organiser_owed_minutes: 15, shares_received_minutes: 0, organiser_net_minutes: 15, unpaid_minutes: 0, share_deadline: STARTS, is_split: false },
    }) });
    renderDetail();
    await screen.findByText(DETAIL_CANCELLED.banner);
    expect(figure(DETAIL_CANCELLED.refunded(null))).toBe(fig(50));
    expect(figure(DETAIL_CANCELLED.penalty)).toBe(fig(-15));
    expect(figure(DETAIL_MONEY.net(null))).toBe(fig(15));
    expect(within(money()).queryByText(DETAIL_CANCELLED.kept(null))).toBeNull();
  });

  it("split (Olga and Thandi): the penalty row and the words name it; Thandi's 25 back", async () => {
    serve({ detail: detail({
      status: "cancelled", permissions: CANCELLED_PERMISSIONS,
      players: [seat({ name: "Olga Petrova" }), { ...SAM_SEAT, name: "Thandi Third", paid_minutes: 0, returned_minutes: 25 }],
      money: { price_minutes: 50, organiser_owed_minutes: 15, shares_received_minutes: 0, organiser_net_minutes: 15, unpaid_minutes: 0, share_deadline: STARTS, is_split: true },
    }) });
    renderDetail();
    await screen.findByText(DETAIL_CANCELLED.banner);
    expect(figure(DETAIL_CANCELLED.penalty)).toBe(fig(-15));
    expect(money()).toHaveTextContent(DETAIL_CANCELLED.splitRefundPenaltyNote(null, minutesSpoken(15)));
    expect(money()).toHaveTextContent(DETAIL_CANCELLED.returnedRow(minutesSpoken(25)));
    expect(figure(DETAIL_MONEY.net(null))).toBe(fig(15));
  });

  it("after a check-in nothing is a penalty: what was paid stands", async () => {
    serve({ detail: detail({
      status: "cancelled", players: [seat()], permissions: CANCELLED_PERMISSIONS,
      attendance: { checked_in_at: "2026-09-30T16:01:00Z", players_checked_in: 1 },
      money: { price_minutes: 50, organiser_owed_minutes: 50, shares_received_minutes: 0, organiser_net_minutes: 50, unpaid_minutes: 0, share_deadline: STARTS, is_split: false },
    }) });
    renderDetail();
    await screen.findByText(DETAIL_CANCELLED.banner);
    expect(within(money()).queryByText(DETAIL_CANCELLED.penalty)).toBeNull();
    expect(figure(DETAIL_CANCELLED.kept(null))).toBe(fig(50));
  });
});

describe("M5-8 — a member taken off the game is told so, not 'Booking not found'", () => {
  const REMOVED: MySeat = {
    participant_id: PID.alex, booking_id: BOOKING, status: "removed", lapsed: false, settled_outside: false,
    booking_status: "booked", court_name: "Court 4", starts_at: STARTS, ends_at: "2026-09-30T16:45:00Z",
    organiser_name: "Olga", share_minutes: 16, timezone: "Africa/Johannesburg",
  };

  function renderAt(url: string) {
    return renderPage(
      <Routes>
        <Route path="/bookings/:bookingId" element={<BookingDetailPage />} />
        <Route path="/bookings" element={<p>The bookings grid</p>} />
      </Routes>,
      { initialEntries: [url] },
    );
  }

  it("with the seat named by the link: 'You were taken off this game', by whom and which game", async () => {
    serve({
      detail: { path: DETAIL_PATH, respond: () => refuse(404, { error: "booking_not_found" }) },
      extra: [{ path: `/api/v1/me/invites/${PID.alex}`, body: REMOVED }],
    });
    renderAt(`/bookings/${BOOKING}?seat=${PID.alex}`);
    expect(await screen.findByText(DETAIL_GONE.removedTitle)).toBeInTheDocument();
    expect(screen.getByText(/^Olga took you off Court 4, /)).toBeInTheDocument();
    expect(screen.queryByText(DETAIL_COPY.notFoundTitle)).toBeNull();
    expect(screen.getByRole("link", { name: DETAIL_GONE.wallet })).toHaveAttribute("href", "/wallet");
  });

  it("a seat of another booking, or none named, keeps the general sentence", async () => {
    serve({
      detail: { path: DETAIL_PATH, respond: () => refuse(404, { error: "booking_not_found" }) },
      extra: [{ path: `/api/v1/me/invites/${PID.alex}`, body: { ...REMOVED, booking_id: "b-other" } }],
    });
    renderAt(`/bookings/${BOOKING}?seat=${PID.alex}`);
    expect(await screen.findByText(DETAIL_COPY.notFoundTitle)).toBeInTheDocument();
    expect(screen.queryByText(DETAIL_GONE.removedTitle)).toBeNull();
  });
});
