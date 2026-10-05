import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { ADMIN_CANCEL } from "@/lib/adminCancelCopy";
import { ALEX_SEAT, adminView, seat } from "@/components/players/__tests__/detailKit";
import { AdminCancelPanel } from "./AdminCancelPanel";

/**
 * R16 J16-7 — the club cancelling a started, checked-in split session named the organiser's
 * outcome ("Paid 15 · Back to Owen 0") and nothing about the partners: their shares stand — they
 * stay with the organiser. The panel says so before the press, by name and figure.
 */
beforeEach(() => { signOut(); signIn({ isAdmin: true }); stubFetch([]); });
afterEach(() => { vi.unstubAllGlobals(); });

const STARTED_NOW = () => new Date("2026-09-30T16:20:00Z").getTime();
const checkedIn = (players: ReturnType<typeof seat>[]) => adminView({
  players, attendance: { ...adminView().attendance, checked_in_at: "2026-09-30T15:58:00Z", players_checked_in: 1 },
});
const ORGANISER = seat({ user_id: "u-sam", name: "Sam Petersen" });
const partner = (name: string, paid: number, over: Record<string, unknown> = {}) =>
  seat({ ...ALEX_SEAT, participant_id: `p-${name}`, user_id: `u-${name}`, seat: 2, team: "A", name, status: "accepted", consented_minutes: 15, share_minutes: 15, paid_minutes: paid, ...over });

describe("R16 J16-7 — the partners' shares stand", () => {
  it("one partner who paid: named, with the figure, staying with the organiser", () => {
    renderPage(<AdminCancelPanel detail={checkedIn([ORGANISER, partner("Owen Partner", 15)])} reload={() => {}} now={STARTED_NOW} />);
    expect(screen.getByText(ADMIN_CANCEL.sharesStand(["Owen's 15 minutes"], "Sam"), { exact: false })).toBeInTheDocument();
    expect(ADMIN_CANCEL.sharesStand(["Owen's 15 minutes"], "Sam")).toBe("Partners' shares stand: Owen's 15 minutes stay with Sam.");
  });

  it("two partners: both; a partner who paid nothing, or a settled-by-hand one, is not listed", () => {
    renderPage(<AdminCancelPanel detail={checkedIn([
      ORGANISER, partner("Owen Partner", 15), partner("Pia Partner", 10), partner("Zed Nopay", 0), partner("Hal Hand", 15, { settled_outside: true }),
    ])} reload={() => {}} now={STARTED_NOW} />);
    expect(screen.getByText(ADMIN_CANCEL.sharesStand(["Owen's 15 minutes", "Pia's 10 minutes"], "Sam"), { exact: false })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Zed|Hal/);
  });

  it("nobody checked in yet: shares come back, so nothing is said of them standing", () => {
    const notIn = adminView({ players: [ORGANISER, partner("Owen Partner", 15)] });
    renderPage(<AdminCancelPanel detail={notIn} reload={() => {}} now={STARTED_NOW} />);
    expect(document.body.textContent).not.toMatch(/shares stand/);
  });
});
