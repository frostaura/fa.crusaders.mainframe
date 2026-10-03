import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceFrame, BalanceTransport } from "@/lib/liveBalance";
import { shareMovementPlain, shareRowSentence } from "@/lib/walletCopy";
import { ToastProvider } from "../Toast";
import { MinutesChip } from "./MinutesChip";
import { signIn, signOut, stubFetch } from "../../test/harness";

/**
 * R11 E11-1 — a share toast ignored WHY the share moved: after an outage refund the partner read
 * "15 minutes of your share of Court 4 came back from Cleo", after a no-show "11 minutes … came back
 * from Ava" (4 kept, unexplained), after a late check-in "15 minutes moved to Fay for your share" —
 * while the inbox said "the club refunded the session" / "taken again — the session was attended".
 * The frame now carries `share_cause` (+ `share_kept_minutes` on a no-show); the phone words it.
 */

const ME = "44444444-4444-4444-4444-444444444444";
const AVA = "66666666-6666-6666-6666-666666666666";
const PLACE = { courtName: "Court 4", startsAt: "2026-10-03T16:00:00Z" };

describe("R11 E11-1 — the share sentence says the cause", () => {
  it("a partner's outage refund names the box", () => {
    expect(shareRowSentence({ side: "partner", signed: 15, place: PLACE, other: "Cleo Banda", cause: "outage_refund" }))
      .toBe("15 minutes of your share of Court 4 came back — the club refunded the session: the court's box was offline");
  });
  it("a partner's no-show return names the penalty and their part of it", () => {
    expect(shareRowSentence({ side: "partner", signed: 11, place: PLACE, other: "Ava Moyo", cause: "no_show", kept: 4 }))
      .toBe("11 minutes of your share of Court 4 came back — nobody checked in, and 4 minutes are your part of the no-show penalty");
  });
  it("the organiser's side of a no-show names the partner's part", () => {
    expect(shareRowSentence({ side: "organiser", signed: -11, place: PLACE, other: "Ava Moyo", cause: "no_show", kept: 4 }))
      .toBe("11 minutes went back to Ava from their share of Court 4 — nobody checked in, and 4 minutes are Ava's part of the no-show penalty");
  });
  it("a late check-in takes the share again, said as that", () => {
    expect(shareRowSentence({ side: "partner", signed: -15, place: PLACE, other: "Fay Dube", cause: "attended" }))
      .toBe("15 minutes taken again for your share of Court 4 — the session was attended");
  });
  it("the plain sentence (no booking to name) carries the cause too", () => {
    expect(shareMovementPlain(15, "booking_cancelled", undefined))
      .toBe("A share of a split booking moved 15 minutes into your wallet — the booking was cancelled.");
    expect(shareMovementPlain(15, undefined, undefined)).toBe("A share of a split booking moved 15 minutes into your wallet.");
  });
  it("an unknown cause falls back to today's words", () => {
    expect(shareRowSentence({ side: "partner", signed: 15, place: PLACE, other: "Cleo Banda", cause: "something_new" }))
      .toBe("15 minutes of your share of Court 4 came back from Cleo");
  });
});

afterEach(() => { vi.unstubAllGlobals(); signOut(); localStorage.clear(); });

function mount() {
  const whoami = signIn({ isAdmin: false });
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet?limit=5", body: {
      balance_minutes: 211, total_entries: 1, offset: 0, limit: 5,
      entries: [{
        id: "e1", at: "2026-10-03T18:00:00Z", from: "Ava Moyo", to: "Me", amountMinutes: 11, signedAmountMinutes: 11,
        type: "ShareTransfer", comment: "Share returned", subjectUserId: ME, subjectName: "Me",
        actorUserId: AVA, actorName: "Ava Moyo", relatedBookingId: "b4",
      }],
    } },
    { path: "/api/v1/wallet", body: { balance_minutes: 200, entries: [], total_entries: 0, offset: 0, limit: 100 } },
    { path: "/api/v1/bookings/b4", body: {
      booking_id: "b4", court_name: "Court 4", starts_at: PLACE.startsAt,
      organiser: { user_id: AVA, name: "Ava Moyo", photo_url: null },
      players: [{ kind: "member", user_id: ME, name: "Me Too", paid_minutes: 0 }],
    } },
  ]);
  let live: { onFrame: (f: BalanceFrame) => void } | null = null;
  const transport: BalanceTransport = { open: (args) => { live = args; return Promise.resolve({ close: () => { live = null; } }); } };
  render(
    <MemoryRouter><AuthProvider><BalanceProvider transport={transport}>
      <ToastProvider><MinutesChip /></ToastProvider>
    </BalanceProvider></AuthProvider></MemoryRouter>,
  );
  return (f: BalanceFrame) => act(async () => { live?.onFrame(f); });
}

describe("R11 E11-1 — the chip's toast carries the frame's share cause", () => {
  it("a no-show share return is said with the penalty, not 'came back from Ava'", async () => {
    const push = mount();
    await push({ balance_minutes: 200 });
    await push({ balance_minutes: 211, delta_minutes: 11, reason: "share_transfer", share_cause: "no_show", share_kept_minutes: 4 });
    expect(await screen.findByText(
      "11 minutes of your share of Court 4 came back — nobody checked in, and 4 minutes are your part of the no-show penalty",
    )).toBeInTheDocument();
  });
});
