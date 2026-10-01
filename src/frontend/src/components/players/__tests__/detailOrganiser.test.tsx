import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { refuse, signOut } from "@/test/harness";
import type { PlayerPickerDialogProps } from "@/components/players/PlayerPicker";
import { DETAIL_ACTIONS, DETAIL_COPY, PLAYERS_REFUSAL, SHARE_LINK, playersRefusal } from "@/lib/playersCopy";
import { ApiError } from "@/lib/api";
import { ALEX_SEAT, DETAIL_PATH, OPEN_SEAT, PID, SAM_SEAT, detail, renderDetail, seat, serve } from "./detailKit";

/** Lane A's picker, stood in for: one button per kind of pick. */
vi.mock("@/components/players/PlayerPicker", () => ({
  PlayerPicker: () => null,
  PlayerPickerDialog: (props: PlayerPickerDialogProps) => (props.open ? (
    <div role="dialog" aria-label={props.title}>
      <button type="button" onClick={() => props.onPick({ kind: "member", userId: "u-jo", name: "Jo van Wyk", photoUrl: null })}>Pick Jo</button>
      <button type="button" onClick={() => props.onPick({ kind: "guest", name: "Themba" })}>Pick a guest</button>
      <button type="button" onClick={() => props.onPick({ kind: "link" })}>Pick a link</button>
    </div>
  ) : null),
}));

/**
 * The organiser's hand on the booking page: remind, invite, remove and hand on a link — every
 * success said in a sentence, every refusal through `playersRefusal`, and a re-read after each.
 */

beforeEach(() => { signOut(); });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const nav = navigator as unknown as Record<string, unknown>;
  delete nav.share;
  delete nav.clipboard;
});

/** Own properties on the real navigator, so its prototype (userAgent, onLine…) is untouched. */
function stubNavigator(share: unknown, clipboard: unknown) {
  Object.defineProperty(navigator, "share", { value: share, configurable: true, writable: true });
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true, writable: true });
}

const SEAT = (pid: string) => `${DETAIL_PATH}/players/${pid}`;
const reads = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method === "GET" && c.path === DETAIL_PATH).length;
const notice = () => document.querySelector("[data-detail-notice]");

describe("remind", () => {
  it("says the nudges left, and re-reads the page", async () => {
    const stub = serve({ extra: [{ method: "POST", path: `${SEAT(PID.alex)}/nudge`, body: { participant_id: PID.alex, nudges_left: 1 } }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.nudgeFor("Alex") }));
    await waitFor(() => expect(notice()).toHaveTextContent(DETAIL_ACTIONS.nudged("Alex", 1)));
    await waitFor(() => expect(reads(stub.calls)).toBeGreaterThanOrEqual(2));
  });

  it("says the rate limit with the time it lifts, on a 429", async () => {
    const body = { error: "nudge_limit", limit: 2, retry_after: "2026-09-29T16:00:00Z" };
    serve({ extra: [{ method: "POST", path: `${SEAT(PID.alex)}/nudge`, status: 429, body }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.nudgeFor("Alex") }));
    const expected = playersRefusal(new ApiError(429, body));
    expect(expected).toContain("Tue 29 Sep, 18:00");
    await waitFor(() => expect(notice()).toHaveTextContent(expected));
  });

  it("offers no reminder to a player who has answered and paid", async () => {
    serve();
    renderDetail();
    await screen.findByRole("button", { name: DETAIL_ACTIONS.nudgeFor("Alex") });
    expect(screen.queryByRole("button", { name: DETAIL_ACTIONS.nudgeFor("Sam") })).not.toBeInTheDocument();
  });
});

describe("invite", () => {
  /** Three players: a seat is free. */
  const three = () => detail({ players: [seat(), SAM_SEAT, ALEX_SEAT] });

  it("sends the pick as one player spec and says who is invited", async () => {
    const stub = serve({ detail: three(), extra: [{
      method: "POST", path: `${DETAIL_PATH}/players`,
      body: { booking_id: "b", participants: [{ participant_id: "p-jo", seat: 4, user_id: "u-jo", guest_name: null, status: "invited", share_minutes: 25, invite_token: "t", invite_path: "/j/t" }] },
    }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.invite }));
    fireEvent.click(within(screen.getByRole("dialog", { name: DETAIL_ACTIONS.inviteTitle })).getByRole("button", { name: "Pick Jo" }));
    await waitFor(() => expect(notice()).toHaveTextContent(DETAIL_ACTIONS.invited("Jo")));
    const post = stub.calls.find((c) => c.method === "POST" && c.path === `${DETAIL_PATH}/players`);
    expect(post?.body).toEqual({ players: [{ userId: "u-jo" }] });
    // A member invite does not open a share: they were notified.
    expect(screen.queryByRole("dialog", { name: SHARE_LINK.readyTitle })).not.toBeInTheDocument();
  });

  it("offers the new open seat's one-time link at once", async () => {
    serve({ detail: three(), extra: [{
      method: "POST", path: `${DETAIL_PATH}/players`,
      body: { booking_id: "b", participants: [{ participant_id: "p-new", seat: 4, user_id: null, guest_name: null, status: "invited", share_minutes: 25, invite_token: "tok123", invite_path: "/j/tok123" }] },
    }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.invite }));
    fireEvent.click(screen.getByRole("button", { name: "Pick a link" }));
    const dialog = await screen.findByRole("dialog", { name: SHARE_LINK.readyTitle });
    expect(within(dialog).getByRole("textbox", { name: SHARE_LINK.linkLabel })).toHaveValue(`${window.location.origin}/j/tok123`);
  });

  it.each([
    ["player_previously_declined", 409, { error: "player_previously_declined", user_id: "u-jo" }],
    ["player_previously_removed", 409, { error: "player_previously_removed", user_id: "u-jo" }],
    ["player_invite_limit", 409, { error: "player_invite_limit", limit: 8, invites_made: 8 }],
    ["booking_full", 409, { error: "booking_full" }],
  ])("says %s as a sentence", async (_code, status, body) => {
    serve({ detail: three(), extra: [{ method: "POST", path: `${DETAIL_PATH}/players`, status, body }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.invite }));
    fireEvent.click(screen.getByRole("button", { name: "Pick Jo" }));
    await waitFor(() => expect(notice()).toHaveTextContent(playersRefusal(new ApiError(status, body))));
    expect(notice()?.textContent).not.toMatch(/player_|booking_full/);
  });

  it("hides Invite once all four seats are taken", async () => {
    serve({ detail: detail({ players: [seat(), SAM_SEAT, ALEX_SEAT, { ...OPEN_SEAT, kind: "guest", name: "Themba" }] }) });
    renderDetail();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: DETAIL_ACTIONS.invite })).not.toBeInTheDocument();
  });
});

describe("remove", () => {
  it("confirms first, with the refund said, then removes and re-reads", async () => {
    const stub = serve({ extra: [{ method: "DELETE", path: SEAT(PID.sam), body: { participant_id: PID.sam, status: "removed" } }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.removeFor("Sam") }));
    const dialog = screen.getByRole("dialog", { name: DETAIL_ACTIONS.removeTitle("Sam") });
    expect(dialog).toHaveTextContent(DETAIL_ACTIONS.removeBody("Sam"));
    expect(stub.calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ACTIONS.removeConfirm }));
    await waitFor(() => expect(notice()).toHaveTextContent(DETAIL_ACTIONS.removed("Sam")));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(reads(stub.calls)).toBeGreaterThanOrEqual(2));
    // R2 F2-12 — focus lands on the Players heading, never <body>.
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: DETAIL_COPY.playersTitle })).toHaveFocus());
  });

  it("keeps a refusal in the dialog as a sentence", async () => {
    serve({ extra: [{ method: "DELETE", path: SEAT(PID.sam), status: 409, body: { error: "booking_not_open" } }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.removeFor("Sam") }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: DETAIL_ACTIONS.removeConfirm }));
    expect(await within(screen.getByRole("dialog")).findByText(PLAYERS_REFUSAL.booking_not_open)).toBeInTheDocument();
  });
});

describe("share a seat's link", () => {
  function linkRoute() {
    return { method: "POST", path: `${SEAT(PID.open)}/link`, body: { participant_id: PID.open, invite_token: "fresh", invite_path: "/j/fresh" } };
  }

  async function makeLink() {
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.linkFor("Open seat") }));
    const confirm = screen.getByRole("dialog", { name: SHARE_LINK.confirmTitle("Open seat") });
    expect(confirm).toHaveTextContent(SHARE_LINK.confirmBody);
    fireEvent.click(within(confirm).getByRole("button", { name: SHARE_LINK.make }));
    return screen.findByRole("dialog", { name: SHARE_LINK.readyTitle });
  }

  it("says a new link replaces the old one, then shares through the phone's share sheet", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    stubNavigator(share, { writeText: vi.fn() });
    serve({ extra: [linkRoute()] });
    const dialog = await makeLink();
    expect(dialog).toHaveTextContent(SHARE_LINK.newLinkNote);
    fireEvent.click(within(dialog).getByRole("button", { name: SHARE_LINK.share }));
    await waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: `${window.location.origin}/j/fresh` })));
  });

  it("falls back to the clipboard when the share sheet fails, and says Link copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const share = vi.fn().mockRejectedValue(new Error("not allowed"));
    stubNavigator(share, { writeText });
    serve({ extra: [linkRoute()] });
    const dialog = await makeLink();
    fireEvent.click(within(dialog).getByRole("button", { name: SHARE_LINK.share }));
    expect(await within(dialog).findByText(SHARE_LINK.copied)).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/j/fresh`);
  });

  it("copies straight to the clipboard where there is no share sheet", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator(undefined, { writeText });
    serve({ extra: [linkRoute()] });
    const dialog = await makeLink();
    expect(within(dialog).queryByRole("button", { name: SHARE_LINK.share })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: SHARE_LINK.copy }));
    expect(await within(dialog).findByText(SHARE_LINK.copied)).toBeInTheDocument();
  });

  it("says nothing when the member closes the share sheet themselves", async () => {
    const share = vi.fn().mockRejectedValue(Object.assign(new Error("closed"), { name: "AbortError" }));
    const writeText = vi.fn();
    stubNavigator(share, { writeText });
    serve({ extra: [linkRoute()] });
    const dialog = await makeLink();
    fireEvent.click(within(dialog).getByRole("button", { name: SHARE_LINK.share }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(writeText).not.toHaveBeenCalled();
    expect(within(dialog).queryByText(SHARE_LINK.copied)).not.toBeInTheDocument();
  });

  it("keeps a refusal to make the link in the dialog", async () => {
    serve({ extra: [{ method: "POST", path: `${SEAT(PID.open)}/link`, status: 409, body: { error: "booking_not_open" } }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.linkFor("Open seat") }));
    fireEvent.click(screen.getByRole("button", { name: SHARE_LINK.make }));
    expect(await screen.findByText(PLAYERS_REFUSAL.booking_not_open)).toBeInTheDocument();
  });

  it("answers a stale link route's refusal the same way even through a refuse() handler", async () => {
    serve({ extra: [{ method: "POST", path: `${SEAT(PID.open)}/link`, respond: () => refuse(409, { error: "conflict_retry" }) }] });
    renderDetail();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.linkFor("Open seat") }));
    fireEvent.click(screen.getByRole("button", { name: SHARE_LINK.make }));
    expect(await screen.findByText(PLAYERS_REFUSAL.conflict_retry)).toBeInTheDocument();
  });
});

describe("seat buttons are full touch targets (R2 F2-15)", () => {
  it("Remind, Share link and Remove are the 44 px size, not the 36 px small one", async () => {
    serve();
    renderDetail();
    const buttons = [
      await screen.findByRole("button", { name: DETAIL_ACTIONS.nudgeFor("Alex") }),
      screen.getByRole("button", { name: DETAIL_ACTIONS.linkFor("Open seat") }),
      screen.getByRole("button", { name: DETAIL_ACTIONS.removeFor("Sam") }),
    ];
    for (const b of buttons) {
      expect(b.className).toContain("min-h-touch");
      expect(b.className).not.toMatch(/\bh-9\b/);
    }
  });
});
