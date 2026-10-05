import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { signOut } from "@/test/harness";
import type { Invite } from "@/lib/playersApi";
import { INVITES_COPY } from "@/lib/playersCopy";
import { inviteHeading, inviteStatus } from "../invites/inviteFacts";
import { ALEX_SEAT, playerView, renderDetail, seat, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * R16 J16-1 — a seat asked to agree to a new share said "The club has asked you for …" when it was
 * the ORGANISER who changed the split. BE16b now says who (`share_changed_by`, with the organiser's
 * `share_changed_by_name`); the club is named only when it was the club (or, with no changer on
 * record, a seat the club accepted that never agreed to anything).
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const asked = (over: Record<string, unknown>) => playerView({
  players: [
    seat({ user_id: "u-sam", name: "Sam Petersen" }),
    seat({ ...ALEX_SEAT, seat: 2, team: "A", status: "accepted", needs_consent: true, share_minutes: 25, target_minutes: 25, unpaid_minutes: 25, ...over }),
  ],
});

describe("R16 J16-1 — the booking page names who changed the share", () => {
  it("the organiser, never agreed before: 'Sam changed your share to …', not 'The club has asked you'", async () => {
    serve({ detail: asked({ consented_minutes: 0, share_changed_by: "organiser", share_changed_by_name: "Sam Petersen" }) });
    renderDetail();
    expect(await screen.findByText("Sam changed your share to 25 minutes. Review it to say yes.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/The club has asked you/);
  });

  it("the organiser, after a yes to less: says it went up, and who did it", async () => {
    serve({ detail: asked({ consented_minutes: 15, share_changed_by: "organiser", share_changed_by_name: "Sam Petersen" }) });
    renderDetail();
    expect(await screen.findByText("Sam changed your share to 25 minutes. Review it to say yes again.")).toBeInTheDocument();
  });

  it("the club: names the club", async () => {
    serve({ detail: asked({ consented_minutes: 15, share_changed_by: "club", share_changed_by_name: null }) });
    renderDetail();
    expect(await screen.findByText("The club changed your share to 25 minutes. Review it to say yes again.")).toBeInTheDocument();
  });

  it("no changer on record (an older API): the sentences it always said", async () => {
    serve({ detail: asked({ consented_minutes: 0 }) });
    renderDetail();
    expect(await screen.findByText("The club has asked you for 25 minutes — review it to say yes.")).toBeInTheDocument();
  });
});

describe("R16 J16-1 — the invite says who changed the share", () => {
  const invite = (over: Partial<Invite> & Record<string, unknown>): Invite => ({
    participant_id: "p", booking_id: "b", status: "accepted", seat: 2, team: "A", open_link: false,
    court_name: "Court 1", starts_at: "2026-10-08T06:00:00Z", ends_at: "2026-10-08T06:45:00Z",
    organiser: { user_id: "u-owen", name: "Owen Organiser", photo_url: null },
    players: 3, share_minutes: 25, to_pay_minutes: 25, needs_consent: true, consented_minutes: 0,
    balance_minutes: 100, spendable_minutes: 100, held_minutes: 0, balance_after_minutes: 75, short_by_minutes: 0,
    share_deadline: "2026-10-08T04:00:00Z", cap: null, ...over,
  } as Invite);

  it("the organiser changed it, never agreed before: not 'The club added you'", () => {
    const i = invite({ share_changed_by: "organiser", share_changed_by_name: "Owen Organiser" });
    expect(inviteHeading(i, "x")).toEqual({ title: INVITES_COPY.shareChangedTitle, line: "Owen changed your share to 25 minutes. Check it and say yes." });
    expect(inviteStatus(i).text).toBe(INVITES_COPY.statusShareChanged);
    expect(inviteStatus(i).text).not.toMatch(/club/i);
  });

  it("the club changed it: the club's", () => {
    const i = invite({ consented_minutes: 15, share_changed_by: "club", share_changed_by_name: null });
    expect(inviteHeading(i, "x").line).toBe("The club changed your share to 25 minutes. Check it and say yes again.");
  });

  it("no changer on record: as before", () => {
    expect(inviteHeading(invite({}), "x").title).toBe(INVITES_COPY.askedFirstTitle);
  });
});
