import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { signOut } from "@/test/harness";
import type { Invite } from "@/lib/playersApi";
import { BOOK_SPLIT, CHANGE_SPLIT, DETAIL_MONEY, INVITES_COPY, askedAgainLine, askedFirstLine } from "@/lib/playersCopy";
import { answerHeading, inviteStatus } from "../invites/inviteFacts";
import { ALEX_SEAT, DETAIL_PATH, PID, SAM_SEAT, detail, renderDetail, seat, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * Review round 14, J14-9 across the product: "went up" / "asked again" only for a seat that had
 * agreed to a smaller share (`consented_minutes > 0`). A seat the club accepted without asking has
 * agreed to nothing — it is asked for its share, the first time. Varied: never agreed, agreed then
 * raised, and an older server that sends no `consented_minutes` on an invite.
 */
beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

type InviteWire = Invite & { consented_minutes?: number };

const invite = (over: Partial<InviteWire> = {}): InviteWire => ({
  participant_id: "p1", booking_id: "b1", status: "accepted", seat: 2, team: "A", open_link: false, court_name: "Court 1",
  starts_at: "2026-10-10T08:00:00Z", ends_at: "2026-10-10T08:45:00Z", organiser: { user_id: "u-owen", name: "Owen Brand", photo_url: null },
  players: 3, share_minutes: 12, to_pay_minutes: 12, needs_consent: true, balance_minutes: 100, spendable_minutes: 100, held_minutes: 0,
  balance_after_minutes: 88, short_by_minutes: 0, share_deadline: "2026-10-12T08:45:00Z", cap: null, ...over,
});

describe("J14-9 — an invite the club accepted without asking", () => {
  it("never agreed: the club's ask, on the card, the heading and the page title", () => {
    const never = invite({ consented_minutes: 0 });
    expect(inviteStatus(never).text).toBe(INVITES_COPY.statusAskedFirst);
    const heading = answerHeading(never, INVITES_COPY.sheetTitle, false);
    expect(heading).toEqual({ title: INVITES_COPY.askedFirstTitle, line: askedFirstLine(12) });
    expect(askedFirstLine(12)).toBe("The club has asked you for 12 minutes — check it and say yes.");
    expect(`${heading.title} ${heading.line} ${inviteStatus(never).text}`).not.toMatch(/went up|again/);
  });

  it("agreed to less and raised: still asked again", () => {
    const raised = invite({ consented_minutes: 8 });
    expect(inviteStatus(raised).text).toBe(INVITES_COPY.statusAskedAgain);
    expect(answerHeading(raised, INVITES_COPY.sheetTitle, false)).toEqual({ title: INVITES_COPY.askedAgainTitle, line: askedAgainLine("Owen", 12) });
  });

  it("an older server (no consented_minutes) keeps the asked-again words", () => {
    expect(inviteStatus(invite()).text).toBe(INVITES_COPY.statusAskedAgain);
  });
});

describe("J14-9 — the booking page's other surfaces (already keyed on consent; pinned)", () => {
  it("the money list and the seat chip say 'not agreed', never 'Asked again', for a never-agreed seat", async () => {
    const never = { ...ALEX_SEAT, status: "accepted" as const, share_minutes: 12, consented_minutes: 0, unpaid_minutes: 12, needs_consent: true };
    serve({ detail: detail({ players: [seat(), SAM_SEAT, never] }) });
    renderDetail();
    const money = await screen.findByRole("region", { name: DETAIL_MONEY.title });
    expect(within(money).getByText(DETAIL_MONEY.notAgreedRow("12 minutes"))).toBeInTheDocument();
    expect(money).not.toHaveTextContent(/Asked again/);
    expect(screen.queryByRole("listitem", { name: /^Alex, Asked again$/ })).toBeNull();
  });
});

const SPLIT = `${DETAIL_PATH}/split`;
const PREVIEW = "/api/v1/players/split-preview";

function previewOf({ body }: { body: unknown }) {
  const req = body as { priceMinutes: number; players: { seat: number; amount?: number }[] };
  const partners = req.players.map((p) => ({ seat: p.seat, team: p.seat <= 2 ? "A" : "B", share_minutes: p.amount ?? 25, weight: 1 }));
  const taken = partners.reduce((n, p) => n + p.share_minutes, 0);
  return { price_minutes: req.priceMinutes, shares: [{ seat: 1, team: "A", share_minutes: req.priceMinutes - taken, weight: 1 }, ...partners] };
}

async function changeSamTo30(samConsented: number, alsoAlex: boolean) {
  const sam = { ...SAM_SEAT, consented_minutes: samConsented };
  const alex = { ...ALEX_SEAT, status: "accepted" as const, consented_minutes: 0, needs_consent: true, unpaid_minutes: 25 };
  const shares = [{ participant_id: PID.sam, seat: 2, share_minutes: 30, weight: 1, needs_consent: true }];
  if (alsoAlex) shares.push({ participant_id: PID.alex, seat: 3, share_minutes: 25, weight: 1, needs_consent: true });
  serve({
    detail: detail({ players: alsoAlex ? [seat(), sam, alex] : [seat(), sam] }),
    extra: [
      { method: "POST", path: PREVIEW, respond: previewOf },
      { method: "PUT", path: SPLIT, body: { booking_id: "b", split_mode: "amount", shares } },
    ],
  });
  renderDetail();
  fireEvent.click(await screen.findByRole("button", { name: CHANGE_SPLIT.open }));
  const dialog = await screen.findByRole("dialog", { name: CHANGE_SPLIT.title });
  fireEvent.click(within(dialog).getByRole("radio", { name: BOOK_SPLIT.modes.amount }));
  fireEvent.change(within(dialog).getByRole("textbox", { name: BOOK_SPLIT.amountLabel("Sam") }), { target: { value: "30" } });
  const save = within(dialog).getByRole("button", { name: CHANGE_SPLIT.save });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
}

const notice = () => document.querySelector("[data-detail-notice]");

describe("J14-9 — the change-split notice", () => {
  it("only never-agreed seats asked: asked for their share, not 'went up'", async () => {
    await changeSamTo30(0, false);
    await waitFor(() => expect(notice()).toHaveTextContent(CHANGE_SPLIT.doneAskedFirst));
    expect(notice()!.textContent).not.toMatch(/went up/);
  });

  it("one raised and one never agreed: both said", async () => {
    await changeSamTo30(25, true);
    await waitFor(() => expect(notice()).toHaveTextContent(CHANGE_SPLIT.doneAskedBoth));
  });
});
