import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderPage, signIn, signOut, stubFetch } from "@/test/harness";
import { AcceptSheet } from "@/components/players/invites/AcceptSheet";
import { InviteCard } from "@/components/players/invites/InviteCard";
import type { Invite } from "@/lib/playersApi";
import { INVITES_COPY } from "@/lib/playersCopy";

/**
 * R5 §3.5 (asked by lane D2) — an invite card can carry its own answers at its foot, beside (never
 * inside) the button that opens it; and the accept sheet can open straight onto the decline
 * question when the card's Decline opened it.
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

function at(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
}

const INVITE = {
  participant_id: "p0000000-0000-0000-0000-000000000003", booking_id: "b0000000-0000-0000-0000-000000000001",
  status: "invited", seat: 3, team: "B", open_link: false, court_name: "Court 1", starts_at: at(24), ends_at: at(24.75),
  organiser: { user_id: "55555555-5555-5555-5555-555555555555", name: "Sam Petersen", photo_url: null },
  players: 4, share_minutes: 25, to_pay_minutes: 25, needs_consent: false,
  balance_minutes: 120, spendable_minutes: 100, held_minutes: 20, balance_after_minutes: 95, short_by_minutes: 0,
  share_deadline: at(26.75), cap: null,
} as Invite;

describe("InviteCard actions", () => {
  it("without actions the whole card is still one button", () => {
    renderPage(<InviteCard invite={INVITE} onOpen={() => undefined} />);
    const card = document.querySelector(`[data-invite="${INVITE.participant_id}"]`);
    expect(card?.tagName).toBe("BUTTON");
    expect(document.querySelector("[data-invite-actions]")).toBeNull();
  });

  it("with actions: the body opens the invite, the answers sit beside it in the frame", () => {
    const onOpen = vi.fn();
    const onDecline = vi.fn();
    renderPage(
      <InviteCard invite={INVITE} onOpen={onOpen} current
        actions={<button type="button" onClick={onDecline}>{INVITES_COPY.decline}</button>} />,
    );
    const open = document.querySelector<HTMLElement>(`[data-invite="${INVITE.participant_id}"]`);
    expect(open?.tagName).toBe("BUTTON");
    expect(open).toHaveAttribute("aria-current", "true");
    const actions = document.querySelector<HTMLElement>("[data-invite-actions]");
    expect(actions).not.toBeNull();
    // Never a button inside a button: the answers are not in the open button.
    expect(open?.contains(actions)).toBe(false);
    expect(open?.parentElement?.contains(actions)).toBe(true);
    fireEvent.click(within(actions as HTMLElement).getByRole("button", { name: INVITES_COPY.decline }));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(open as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith(INVITE);
  });
});

describe("AcceptSheet startWith", () => {
  function draw(startWith?: "decline") {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: false }) },
      { path: "/api/v1/wallet", body: { balance_minutes: 120, held_minutes: 20, spendable_minutes: 100, held_until: null, entries: [] } },
      { method: "POST", path: "/api/v1/wallet/stream-ticket", status: 503, body: { error: "stream_unavailable" } },
      { path: "/api/v1/me/notifications/unread-count", body: { unread_count: 0 } },
    ]);
    renderPage(
      <AcceptSheet invite={INVITE} open onOpenChange={() => undefined} onReread={() => Promise.resolve()} startWith={startWith} />,
    );
  }

  it("opened from the card's Decline, asks the decline question at once, focus on the safe answer", async () => {
    draw("decline");
    const keep = await screen.findByRole("button", { name: INVITES_COPY.declineKeep });
    expect(screen.getByRole("button", { name: INVITES_COPY.declineConfirm })).toBeInTheDocument();
    await vi.waitFor(() => expect(keep).toHaveFocus());
  });

  it("opened otherwise, asks nothing", async () => {
    draw();
    expect(await screen.findByRole("button", { name: INVITES_COPY.decline })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: INVITES_COPY.declineConfirm })).toBeNull();
  });
});
