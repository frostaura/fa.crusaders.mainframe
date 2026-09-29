import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@/components/Toast";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceTransport } from "@/lib/liveBalance";
import { refuse, signIn, signOut, stubFetch, type StubCall, type StubRoute } from "@/test/harness";
import { BOOK_SEATS, BOOK_SHEET } from "@/lib/bookingsCopy";
import { formatCredits } from "@/lib/utils";
import {
  BOOK_CONFIRM, BOOK_PLAYERS, BOOK_SPLIT, PICKER, PLAYERS_REFUSAL, heldLine, owedBackLine,
} from "@/lib/playersCopy";
import { BookSheet, type BookSheetProps } from "../BookSheet";
import { splitShares } from "../splitMath";
import type { SelectedSlot } from "../types";

/**
 * The BookSheet's P11 steps (D11): Players → Split → Confirm for a member, the picker in place,
 * the live preview, the Confirm sentence, booking with players (single and bulk, all-or-nothing),
 * and sharing an open seat's link. Queries go through the copy modules; renders are StrictMode.
 */

// Each walk takes three steps, two debounces and the sheet's 300 ms double-tap guard.
vi.setConfig({ testTimeout: 20_000 });

const TZ = "Africa/Johannesburg";
const ME = "44444444-4444-4444-4444-444444444444";
const C1: SelectedSlot = { courtId: "c1", courtName: "Court 1", startsAt: "2030-09-09T16:00:00.000Z", sliceCount: 3, priceCredits: 100 };
const C2: SelectedSlot = { courtId: "c2", courtName: "Court 2", startsAt: "2030-09-09T17:00:00.000Z", sliceCount: 3, priceCredits: 100 };
const SAM = { user_id: "sam", name: "Sam Petersen", photo_url: null };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  signOut();
});

/** A stream that never speaks, so the wallet read is the only figure. */
const quietStream: BalanceTransport = { open: () => Promise.resolve({ close: () => undefined }) };

function Providers({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <AuthProvider>
        <BalanceProvider transport={quietStream}>
          <ToastProvider>{children}</ToastProvider>
        </BalanceProvider>
      </AuthProvider>
    </MemoryRouter>
  );
}

function open(props: Partial<BookSheetProps> = {}) {
  const onBooked = vi.fn();
  render(
    <BookSheet
      open onOpenChange={vi.fn()} slots={[C1]} timezone={TZ} sliceMinutes={15}
      isAdmin={false} actorUserId={ME} balanceCredits={500} onBooked={onBooked} {...props}
    />,
    { wrapper: Providers, reactStrictMode: true },
  );
  return { onBooked };
}

/** The server's split-preview, answered by the same rules the server applies. */
const PREVIEW: StubRoute = {
  method: "POST",
  path: "/api/v1/players/split-preview",
  respond: ({ body }) => {
    const b = body as { priceCredits: number; splitMode: "equal" | "ratio" | "amount"; organiserWeight?: number; players: { seat: number; guestName?: string; weight?: number; amount?: number }[] };
    const r = splitShares(b.priceCredits, b.splitMode, b.organiserWeight ?? 1, b.players.map((p) => ({
      seat: p.seat, isGuest: p.guestName !== undefined, weight: p.weight, amount: p.amount,
    })));
    if (!r.ok) return refuse(400, { error: r.error });
    return {
      price_credits: b.priceCredits,
      shares: r.shares.map((s) => ({ seat: s.seat, team: s.seat <= 2 ? "A" : "B", share_credits: s.share, weight: s.weight })),
    };
  },
};

const FAVOURITES: StubRoute = { path: "/api/v1/me/partners/favourites", body: { items: [SAM] } };

const posts = (calls: StubCall[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);
const pause = (ms = 350) => new Promise((r) => setTimeout(r, ms));

async function tab(name: string) {
  await userEvent.setup().click(screen.getByRole("tab", { name }));
}

/** Sam (a favourite) in seat 2, an open seat in seat 4. */
async function addSamAndALink() {
  fireEvent.click(screen.getByRole("radio", { name: BOOK_PLAYERS.withOthers }));
  fireEvent.click(screen.getByRole("button", { name: BOOK_SEATS.addToSeat(2) }));
  expect(screen.getByRole("heading", { name: BOOK_SEATS.pickerTitle(2) })).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: PICKER.add(SAM.name) }));
  fireEvent.click(screen.getByRole("button", { name: BOOK_SEATS.addToSeat(4) }));
  await tab(PICKER.link);
  fireEvent.click(screen.getByRole("button", { name: PICKER.linkAdd }));
}

async function next() {
  fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
  await pause();
}

describe("BookSheet — Players", () => {
  it("D3 — shows the court, the time and the price at the top of Players and of Split", async () => {
    stubFetch([FAVOURITES, PREVIEW]);
    open({ slots: [C1, C2] });
    const summary = () => screen.getByRole("list", { name: BOOK_SHEET.summaryLabel });
    expect(within(summary()).getByText("Court 1")).toBeTruthy();
    expect(within(summary()).getByText("Court 2")).toBeTruthy();
    expect(within(summary()).getAllByText(formatCredits(100))).toHaveLength(2);

    await addSamAndALink();
    await next();
    expect(screen.getByRole("list", { name: BOOK_SHEET.summaryLabel })).toBeTruthy();
    expect(within(summary()).getByText("Court 1")).toBeTruthy();
  });

  it("opens on Just me, and Just me books exactly as before — no players on the wire", async () => {
    const stub = stubFetch([{ method: "POST", path: "/api/v1/bookings/", body: { booking_id: "bk-1", balance_after_credits: 400 } }]);
    open();
    expect(screen.getByRole("radio", { name: BOOK_PLAYERS.justMe })).toHaveAttribute("aria-checked", "true");
    await next();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(3, 100, null) }));
    await screen.findByText(BOOK_SHEET.bookedTitle(3, 3));
    const [call] = posts(stub.calls, "/api/v1/bookings/");
    expect(call.raw).toBe(JSON.stringify({ courtId: "c1", startsAt: C1.startsAt, sliceCount: 3 }));
    expect(stub.calls.filter((c) => c.path.includes("split-preview"))).toHaveLength(0);
    expect(document.querySelector("[data-result-players]")).toBeNull();
  });

  it("seats players as two teams, with the picker in place and Back to the seats", async () => {
    stubFetch([FAVOURITES]);
    open();
    await addSamAndALink();
    const court = document.querySelector("[data-court]") as HTMLElement;
    expect(within(court).getByText("Sam")).toBeTruthy();
    expect(within(court).getByText(BOOK_PLAYERS.linkName)).toBeTruthy();
    expect(within(court).getByRole("button", { name: BOOK_SEATS.addToSeat(3) })).toBeTruthy();
    // No dialog inside the sheet: one dialog, with the panel inside it.
    fireEvent.click(within(court).getByRole("button", { name: BOOK_SEATS.addToSeat(3) }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    // Sam is on it already, so the picker shows him as added.
    expect(await screen.findByRole("button", { name: `${SAM.name}, ${PICKER.added}` })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: BOOK_PLAYERS.pickerBack }));
    fireEvent.click(screen.getByRole("button", { name: BOOK_PLAYERS.remove("Sam") }));
    expect(screen.queryByText("Sam")).toBeNull();
    expect(screen.getByRole("list", { name: "Progress" })).toHaveTextContent(BOOK_SHEET.stepOf(1, 3, BOOK_SHEET.steps.players));
  });

  it("F1.9/F1.15 — 'With other players' shows the seats and opens nothing; Just me shows none", async () => {
    stubFetch([FAVOURITES]);
    open();
    expect(document.querySelector("[data-court]")).toBeNull();
    const others = screen.getByRole("radio", { name: BOOK_PLAYERS.withOthers });
    others.focus();
    fireEvent.click(others);
    // Choosing is not navigating: the choice keeps the focus, and no picker has opened.
    expect(document.activeElement).toBe(others);
    expect(document.querySelector("[data-picker-panel]")).toBeNull();
    const court = document.querySelector("[data-court]") as HTMLElement;
    expect(within(court).getByText(BOOK_SEATS.yourTeam)).toBeTruthy();
    expect(within(court).getByText(BOOK_SEATS.otherTeam)).toBeTruthy();
    expect(within(court).getByRole("button", { name: BOOK_SEATS.addToSeat(2) })).toHaveTextContent(BOOK_SEATS.addPartner);
    expect(within(court).getByRole("button", { name: BOOK_SEATS.addToSeat(3) })).toHaveTextContent(BOOK_SEATS.addOpponent);
    // An opponent picked is on the OTHER side, and says so.
    fireEvent.click(within(court).getByRole("button", { name: BOOK_SEATS.addToSeat(3) }));
    fireEvent.click(await screen.findByRole("button", { name: PICKER.add(SAM.name) }));
    const seat3 = document.querySelector('[data-seat="3"]') as HTMLElement;
    expect(seat3).toHaveTextContent("Sam");
    expect(seat3).toHaveTextContent(BOOK_SEATS.opponent);
    fireEvent.click(screen.getByRole("radio", { name: BOOK_PLAYERS.justMe }));
    expect(document.querySelector("[data-court]")).toBeNull();
  });

  it("a guest alone is nothing to split: no Split step, and the guest plays free", async () => {
    stubFetch([FAVOURITES]);
    open({ slots: [{ ...C1, priceCredits: 50 }] });
    fireEvent.click(screen.getByRole("radio", { name: BOOK_PLAYERS.withOthers }));
    fireEvent.click(screen.getByRole("button", { name: BOOK_SEATS.addToSeat(3) }));
    await tab(PICKER.guest);
    fireEvent.change(screen.getByLabelText(PICKER.guestLabel), { target: { value: "Jo" } });
    fireEvent.click(screen.getByRole("button", { name: PICKER.guestAdd }));
    expect(screen.getByRole("list", { name: "Progress" })).toHaveTextContent(BOOK_SHEET.stepOf(1, 2, BOOK_SHEET.steps.players));
    await next();
    expect(screen.getByText("You pay 50.00 cr now. Jo (guest) plays free.")).toBeTruthy();
  });
});

describe("BookSheet — Split", () => {
  it("previews the equal split from the server and says what you pay now and get back", async () => {
    const stub = stubFetch([FAVOURITES, PREVIEW]);
    open();
    await addSamAndALink();
    await next();
    const totals = await screen.findByRole("region", { name: BOOK_SPLIT.totalsLabel });
    await waitFor(() => expect(totals).toHaveTextContent(BOOK_SPLIT.youPayNow("100.00 cr", "66.00 cr")));
    expect(totals).toHaveTextContent("You34.00 cr");
    expect(totals).toHaveTextContent("Sam33.00 cr");
    expect(totals).toHaveTextContent(`${BOOK_PLAYERS.linkName}33.00 cr`);
    const [sent] = posts(stub.calls, "/api/v1/players/split-preview");
    expect(sent.body).toEqual({ priceCredits: 100, splitMode: "equal", players: [{ userId: "sam", seat: 2 }, { link: true, seat: 4 }] });
  });

  it("re-previews a ratio, and ignores a slower answer to the question before", async () => {
    let releaseEqual: () => void = () => undefined;
    const equalGate = new Promise<void>((r) => { releaseEqual = r; });
    stubFetch([FAVOURITES, PREVIEW]);
    const stubbed = globalThis.fetch;
    let equalAsked = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("split-preview") && String(init?.body).includes('"equal"')) {
        equalAsked += 1;
        await equalGate;
      }
      return stubbed(input, init);
    }));
    open();
    await addSamAndALink();
    await next();
    await waitFor(() => expect(equalAsked).toBeGreaterThan(0));
    await userEvent.setup().click(screen.getByRole("radio", { name: BOOK_SPLIT.modes.ratio }));
    fireEvent.change(screen.getByLabelText(BOOK_SPLIT.weightLabel("Sam")), { target: { value: "2" } });
    const totals = screen.getByRole("region", { name: BOOK_SPLIT.totalsLabel });
    // Σw = 1 + 2 + 1: Sam ⌊200/4⌋ = 50, the link 25, you the rest.
    await waitFor(() => expect(totals).toHaveTextContent(BOOK_SPLIT.youPayNow("100.00 cr", "75.00 cr")));
    await act(async () => { releaseEqual(); await pause(50); });
    expect(totals).toHaveTextContent(BOOK_SPLIT.youPayNow("100.00 cr", "75.00 cr"));
  });

  it("says amounts past the price at once, asks the server nothing, and will not continue", async () => {
    const stub = stubFetch([FAVOURITES, PREVIEW]);
    open();
    await addSamAndALink();
    await next();
    await userEvent.setup().click(screen.getByRole("radio", { name: BOOK_SPLIT.modes.amount }));
    // Starts from the equal split, so the fields already add up.
    expect(screen.getByLabelText(BOOK_SPLIT.amountLabel("Sam"))).toHaveValue("33.00");
    const before = posts(stub.calls, "/api/v1/players/split-preview").length;
    fireEvent.change(screen.getByLabelText(BOOK_SPLIT.amountLabel("Sam")), { target: { value: "80" } });
    fireEvent.change(screen.getByLabelText(BOOK_SPLIT.amountLabel(BOOK_PLAYERS.linkName)), { target: { value: "30" } });
    expect(screen.getByText(PLAYERS_REFUSAL.split_exceeds_price)).toBeTruthy();
    await pause(400);
    const sent = posts(stub.calls, "/api/v1/players/split-preview").slice(before).map((c) => c.body as { players: { amount?: number }[] });
    expect(sent.some((b) => b.players.some((p) => p.amount === 80))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.next }));
    expect(screen.getByRole("list", { name: "Progress" })).toHaveTextContent(BOOK_SHEET.stepOf(2, 3, BOOK_SHEET.steps.split));
  });
});

describe("BookSheet — Confirm and the booking", () => {
  it("says who pays what, books with the players, and offers the open seat's link", async () => {
    const stub = stubFetch([
      FAVOURITES, PREVIEW,
      {
        method: "POST", path: "/api/v1/bookings/",
        body: {
          booking_id: "bk-1", balance_after_credits: 400,
          players: {
            booking_id: "bk-1",
            participants: [
              { participant_id: "p2", seat: 2, user_id: "sam", guest_name: null, status: "invited", share_credits: 33, invite_token: "t2", invite_path: "/j/SAMSAMSAMSAMSAMSAMSAM" },
              { participant_id: "p4", seat: 4, user_id: null, guest_name: null, status: "invited", share_credits: 33, invite_token: "t4", invite_path: "/j/OPENOPENOPENOPENOPEN1" },
            ],
          },
          players_error: null,
        },
      },
    ]);
    const share = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...window.navigator, share });
    open();
    await addSamAndALink();
    await next();
    await screen.findByText(BOOK_SPLIT.youPayNow("100.00 cr", "66.00 cr"));
    await next();
    const sentence = "You pay 100.00 cr now; Sam and whoever takes your link are asked for 33.00 cr each.";
    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(screen.getByRole("region", { name: BOOK_CONFIRM.playersLabel })).toHaveTextContent(BOOK_CONFIRM.playersLine(["Sam", BOOK_CONFIRM.linkInLine]));
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(3, 100, null) }));
    await screen.findByText(BOOK_SHEET.bookedTitle(3, 3));
    expect(posts(stub.calls, "/api/v1/bookings/")[0].body).toEqual({
      courtId: "c1", startsAt: C1.startsAt, sliceCount: 3,
      players: [{ userId: "sam", seat: 2 }, { link: true, seat: 4 }], splitMode: "equal",
    });
    // Only the OPEN seat is shared from here — Sam is asked by the club's own invite.
    const shareButtons = screen.getAllByRole("button", { name: BOOK_CONFIRM.shareLink });
    expect(shareButtons).toHaveLength(1);
    fireEvent.click(shareButtons[0]);
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share).toHaveBeenCalledWith(expect.objectContaining({
      title: BOOK_CONFIRM.shareTitle, url: `${window.location.origin}/j/OPENOPENOPENOPENOPEN1`,
    }));
    expect(screen.getByRole("link", { name: BOOK_CONFIRM.seeBooking })).toHaveAttribute("href", "/bookings/bk-1");
  });

  it("copies the link where the phone cannot share, and says so", async () => {
    stubFetch([
      FAVOURITES, PREVIEW,
      {
        method: "POST", path: "/api/v1/bookings/",
        body: {
          booking_id: "bk-1", balance_after_credits: 400, players_error: null,
          players: { booking_id: "bk-1", participants: [{ participant_id: "p2", seat: 2, user_id: null, guest_name: null, status: "invited", share_credits: 50, invite_token: "t", invite_path: "/j/OPENOPENOPENOPENOPEN1" }] },
        },
      },
    ]);
    open();
    fireEvent.click(screen.getByRole("radio", { name: BOOK_PLAYERS.withOthers }));
    fireEvent.click(screen.getByRole("button", { name: BOOK_SEATS.addToSeat(3) }));
    await tab(PICKER.link);
    fireEvent.click(screen.getByRole("button", { name: PICKER.linkAdd }));
    await next();
    await screen.findByText(BOOK_SPLIT.youPayNow("100.00 cr", "50.00 cr"));
    await next();
    fireEvent.click(await screen.findByRole("button", { name: BOOK_SHEET.primary(3, 100, null) }));
    const shareButton = await screen.findByRole("button", { name: BOOK_CONFIRM.shareLink });
    // After every user-event call: `userEvent.setup()` installs a clipboard of its own.
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...window.navigator, share: undefined, clipboard: { writeText } });
    fireEvent.click(shareButton);
    expect(await screen.findByText(BOOK_CONFIRM.linkCopied)).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/j/OPENOPENOPENOPENOPEN1`);
  });

  it("says plainly when the court stood but the players were not added", async () => {
    stubFetch([
      FAVOURITES, PREVIEW,
      { method: "POST", path: "/api/v1/bookings/", body: { booking_id: "bk-1", balance_after_credits: 400, players: null, players_error: "member_not_found" } },
    ]);
    open();
    fireEvent.click(screen.getByRole("radio", { name: BOOK_PLAYERS.withOthers }));
    fireEvent.click(screen.getByRole("button", { name: BOOK_SEATS.addToSeat(3) }));
    fireEvent.click(await screen.findByRole("button", { name: PICKER.add(SAM.name) }));
    await next();
    await next();
    fireEvent.click(await screen.findByRole("button", { name: BOOK_SHEET.primary(3, 100, null) }));
    expect(await screen.findByText(BOOK_CONFIRM.playersError)).toBeTruthy();
    expect(screen.getByRole("link", { name: BOOK_CONFIRM.seeBooking })).toHaveAttribute("href", "/bookings/bk-1");
  });

  it("a batch with players is all-or-nothing: a refusal books nothing and stays on Confirm", async () => {
    const stub = stubFetch([
      FAVOURITES, PREVIEW,
      { method: "POST", path: "/api/v1/bookings/bulk", body: refuse(404, { error: "member_not_found", user_id: "sam" }) },
    ]);
    const { onBooked } = open({ slots: [C1, C2] });
    fireEvent.click(screen.getByRole("radio", { name: BOOK_PLAYERS.withOthers }));
    fireEvent.click(screen.getByRole("button", { name: BOOK_SEATS.addToSeat(3) }));
    fireEvent.click(await screen.findByRole("button", { name: PICKER.add(SAM.name) }));
    await next();
    expect(await screen.findByText(BOOK_SPLIT.eachBooking)).toBeTruthy();
    await next();
    expect(await screen.findByText("On each booking you pay 100.00 cr now; Sam is asked for 50.00 cr.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: BOOK_SHEET.primary(6, 200, null) }));
    expect(await screen.findByText(PLAYERS_REFUSAL.member_not_found)).toBeTruthy();
    const [call] = posts(stub.calls, "/api/v1/bookings/bulk");
    expect(call.body).toMatchObject({ players: [{ userId: "sam", seat: 3 }], splitMode: "equal" });
    expect(onBooked).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: BOOK_SHEET.primary(6, 200, null) })).toBeTruthy();
  });

  it("reads the member's SPENDABLE credits, with the held line under the money", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: { tenant_slug: "crusaders", tenant_id: "t", user_id: ME, is_authenticated: true, is_admin: false } },
      {
        path: "/api/v1/wallet",
        body: { balance_credits: 120, held_credits: 20, spendable_credits: 100, held_until: "2030-09-10T18:00:00Z", entries: [], total_entries: 0, offset: 0, limit: 100 },
      },
    ]);
    signIn({ isAdmin: false });
    open({ balanceCredits: 120 });
    await next();
    const money = await waitFor(() => {
      const dl = document.querySelector("dl")!;
      expect(dl).toHaveTextContent(`${BOOK_SHEET.availableNow}100.00 cr`);
      return dl;
    });
    expect(money).toHaveTextContent(`${BOOK_SHEET.availableAfter}0.00 cr`);
    expect(screen.getByText(heldLine(20, "2030-09-10T18:00:00Z", TZ))).toBeTruthy();
  });

  it("P11: owing partners more than the balance reads as a signed figure, the owed-back line, and what is still needed", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: { tenant_slug: "crusaders", tenant_id: "t", user_id: ME, is_authenticated: true, is_admin: false } },
      {
        path: "/api/v1/wallet",
        body: { balance_credits: 10, held_credits: 0, owed_back_credits: 16, spendable_credits: -6, held_until: null, entries: [], total_entries: 0, offset: 0, limit: 100 },
      },
    ]);
    signIn({ isAdmin: false });
    open({ balanceCredits: 10 });
    await next();
    const money = await waitFor(() => {
      const dl = document.querySelector("dl")!;
      expect(dl).toHaveTextContent(`${BOOK_SHEET.availableNow}−6.00 cr`);
      return dl;
    });
    // 100 to pay from −6: 106 still needed — the rows add up.
    expect(money).toHaveTextContent(`${BOOK_SHEET.stillNeeded}106.00 cr`);
    expect(screen.getByText(owedBackLine(16))).toBeTruthy();
    expect(document.querySelector("[data-held-line]")).toBeNull();
  });
});
