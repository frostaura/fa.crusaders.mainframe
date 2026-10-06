import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceFrame, BalanceTransport } from "@/lib/liveBalance";
import { ToastProvider } from "../Toast";
import { MinutesChip } from "../shell/MinutesChip";
import { signIn, signOut, stubFetch, type StubRoute } from "../../test/harness";

/**
 * R14 — the chip's money toasts, through the real chip (lane FE14m), against BE14b's contract:
 * X14-2 / E14-1: `share_returned` is only a withdrawal; `organiser_removed` and `split_changed` are
 * their own causes, said with `actor_name` ("Omar took you off Court 3 · Mon 7 Oct — 7 minutes came back").
 * J14-4: a late cancel of a split booking ("mixed") counted the partner's share as the penalty.
 * E14-7: a member cancel names the organiser to the partner; cancels and displacements name court and day.
 */

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); signOut(); localStorage.clear(); });

const ME = "44444444-4444-4444-4444-444444444444";
const OLIVIA = "77777777-7777-7777-7777-777777777777";
const BOOKING = "b0000000-0000-0000-0000-0000000000c4";

function mount(extra: StubRoute[] = []) {
  const whoami = signIn({ isAdmin: false });
  const club = { balance_minutes: 200, entries: [] as unknown[], total_entries: 0, offset: 0, limit: 100 };
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    ...extra,
    { path: "/api/v1/wallet", respond: () => ({ ...club }) },
  ]);
  let live: { onFrame: (f: BalanceFrame) => void } | null = null;
  const transport: BalanceTransport = {
    open: (args) => { live = args; return Promise.resolve({ close: () => { live = null; } }); },
  };
  render(
    <MemoryRouter initialEntries={["/bookings"]}>
      <AuthProvider>
        <BalanceProvider transport={transport}>
          <ToastProvider><MinutesChip /></ToastProvider>
        </BalanceProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  const push = (f: BalanceFrame) => act(async () => { live?.onFrame(f); });
  return { club, push };
}

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const toasts = () => [...document.querySelectorAll("[role=status]")].map((n) => n.textContent ?? "").filter((t) => /minute/.test(t));

/** The partner's share row as the wallet's newest entries carry it (r13e13/frames-par.jsonl's +7). */
const shareBack = (n: number) => ({
  id: "r1", at: "2026-10-05T08:39:32Z", from: "Olivia Organiser", to: "Sam Partner", amountMinutes: n, signedAmountMinutes: n,
  type: "ShareTransfer", comment: "Share of a split booking", subjectUserId: ME, subjectName: "Sam Partner",
  actorUserId: OLIVIA, actorName: "Olivia Organiser", relatedBookingId: BOOKING,
});

const PLACE = { court_name: "Court 3", booking_starts_at: "2030-10-07T16:00:00Z" };
const GONE: StubRoute = { path: `/api/v1/bookings/${BOOKING}`, status: 404, body: { error: "booking_not_found" } };
const OMAR = "88888888-8888-8888-8888-888888888888";
const SAM = "99999999-9999-9999-9999-999999999999";
/** The organiser's view of the game, Sam still a partner (a split change) or not (a removal). */
const detail = (partners: unknown[]) => ({
  booking_id: BOOKING, court_name: "Court 3", starts_at: "2030-10-07T16:00:00Z",
  organiser: { user_id: ME, name: "Omar Organiser", photo_url: null }, players: partners,
});

async function share(extra: StubRoute[], signed: number, frame: Partial<BalanceFrame>, row: Record<string, unknown> = {}) {
  const { club, push } = mount(extra);
  await push({ balance_minutes: 286 });
  await wait(120);
  club.balance_minutes = 286 + signed; club.entries = [{ ...shareBack(Math.abs(signed)), signedAmountMinutes: signed, ...row }]; club.total_entries = 1;
  await push({ balance_minutes: 286 + signed, delta_minutes: signed, reason: "share_transfer", ...PLACE, ...frame });
  await wait(600);
  return toasts();
}

describe("R14 X14-2 — the partner hears who took them off, or changed the split", () => {
  it("organiser_removed (booking gone for them): 'Omar took you off Court 3 · Mon 7 Oct — 7 minutes came back.'", async () => {
    expect(await share([GONE], 7, { share_cause: "organiser_removed", actor_name: "Omar Organiser", parts: [{ reason: "share_transfer", delta_minutes: 7, counterparty_name: "Omar Organiser" }] }))
      .toEqual(["Omar took you off Court 3 · Mon 7 Oct — 7 minutes came back."]);
  }, 15_000);

  it("split_changed (still on the game, booking readable): 'Otto changed the split on Court 3 · Mon 7 Oct — 4 minutes came back.'", async () => {
    const readable = { path: `/api/v1/bookings/${BOOKING}`, body: { ...detail([]), organiser: { user_id: OMAR, name: "Otto Organiser", photo_url: null } } };
    expect(await share([readable], 4, { share_cause: "split_changed", actor_name: "Otto Organiser" }))
      .toEqual(["Otto changed the split on Court 3 · Mon 7 Oct — 4 minutes came back."])  // R17 X17-6 — a toast ends with a full stop;
  }, 15_000);

  it("share_returned is the member's own withdrawal: 'You withdrew from Court 3 · Mon 7 Oct — 7 minutes came back.'", async () => {
    expect(await share([GONE], 7, { share_cause: "share_returned", actor_name: null }))
      .toEqual(["You withdrew from Court 3 · Mon 7 Oct — 7 minutes came back."]);
  }, 15_000);

  it("club_removed: 'The club took you off Court 3 · Mon 7 Oct — 10 minutes came back.'", async () => {
    expect(await share([GONE], 10, { share_cause: "club_removed", actor_name: null }))
      .toEqual(["The club took you off Court 3 · Mon 7 Oct — 10 minutes came back."]);
  }, 15_000);
});

describe("R14 X14-2 — the organiser's side mirrors it", () => {
  const out = { from: "Omar Organiser", to: "Sam Partner", actorUserId: SAM, actorName: "Sam Partner" };

  it("share_returned with actor_name: 'Sam withdrew from Court 3 · Mon 7 Oct — 7 minutes went back to them.'", async () => {
    const readable = { path: `/api/v1/bookings/${BOOKING}`, body: detail([]) };
    expect(await share([readable], -7, { share_cause: "share_returned", actor_name: "Sam Partner", parts: [{ reason: "share_transfer", delta_minutes: -7, counterparty_name: "Sam Partner" }] }, out))
      .toEqual(["Sam withdrew from Court 3 · Mon 7 Oct — 7 minutes went back to them."])  // R17 X17-6 — a toast ends with a full stop;
  }, 15_000);

  it("organiser_removed (own act, another tab): 'You took Sam off Court 3 · Mon 7 Oct — 7 minutes went back to them.'", async () => {
    expect(await share([GONE], -7, { share_cause: "organiser_removed", actor_name: null, parts: [{ reason: "share_transfer", delta_minutes: -7, counterparty_name: "Sam Partner" }] }, out))
      .toEqual(["You took Sam off Court 3 · Mon 7 Oct — 7 minutes went back to them."]);
  }, 15_000);

  it("split_changed (own act, another tab): 'You changed the split on Court 3 · Mon 7 Oct — 4 minutes went back to Sam.'", async () => {
    const readable = { path: `/api/v1/bookings/${BOOKING}`, body: detail([]) };
    expect(await share([readable], -4, { share_cause: "split_changed", actor_name: null, parts: [{ reason: "share_transfer", delta_minutes: -4, counterparty_name: "Sam Partner" }] }, out))
      .toEqual(["You changed the split on Court 3 · Mon 7 Oct — 4 minutes went back to Sam."])  // R17 X17-6 — a toast ends with a full stop;
  }, 15_000);
});

describe("R14 E14-7 — who cancelled, and where", () => {
  it("a member cancel tells the partner the organiser's name: 'Omar cancelled Court 3 · Mon 7 Oct — 7 minutes of your share came back.'", async () => {
    expect(await share([GONE], 7, { share_cause: "booking_cancelled", cancelled_by: "member", actor_name: "Omar Organiser" }))
      .toEqual(["Omar cancelled Court 3 · Mon 7 Oct — 7 minutes of your share came back."]);
  }, 15_000);

  it("the organiser's club-cancel toast names the court and the day", async () => {
    const { push } = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push({
      balance_minutes: 223, delta_minutes: 23, reason: "cancellation_refund", cancelled_by: "club", ...PLACE,
      parts: [{ reason: "cancellation_refund", delta_minutes: 30 }, { reason: "share_transfer", delta_minutes: -7, counterparty_name: "Sam Partner" }],
    });
    await wait(400);
    expect(toasts()).toEqual([
      "The club cancelled your booking on Court 3 · Mon 7 Oct: 30 minutes came back, 7 minutes went back to Sam for their share, so 23 minutes came back to your wallet.",
    ]);
  }, 15_000);

  it("a displacement names the court and the time", async () => {
    const { push } = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push({ balance_minutes: 245, delta_minutes: 45, reason: "displaced_refund", ...PLACE, parts: [{ reason: "cancellation_refund", delta_minutes: 45 }] });
    await wait(400);
    expect(toasts()).toEqual([
      "Your booking on Court 3 · Mon 7 Oct, 18:00 was refunded — the court was already in use by an earlier game: 45 minutes back in your wallet.",
    ]);
  }, 15_000);
});

describe("R14 J14-4 — a late cancel of a split booking: the penalty, then each partner's share", () => {
  const late = (shares: { name: string; n: number }[], penalty: number, back: number) => ({
    balance_minutes: 200 + back - penalty - shares.reduce((a, s) => a + s.n, 0),
    delta_minutes: back - penalty - shares.reduce((a, s) => a + s.n, 0), reason: "mixed", cancelled_by: "member" as const, ...PLACE,
    parts: [
      { reason: "cancellation_refund", delta_minutes: back, counterparty_name: null },
      ...shares.map((s) => ({ reason: "share_transfer", delta_minutes: -s.n, counterparty_name: s.name })),
      { reason: "penalty", delta_minutes: -penalty, counterparty_name: null },
    ],
  });

  it("one partner: 'Tess' 7 back to her, the 4-minute penalty, never '11 minutes went on a charge'", async () => {
    const { push } = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push(late([{ name: "Tess Partner", n: 7 }], 4, 15));
    await wait(400);
    expect(toasts()).toEqual([
      "Your booking on Court 3 · Mon 7 Oct was cancelled: 15 minutes came back, 7 minutes went back to Tess for their share, 4 minutes went on a late-cancellation charge, so 4 minutes came back to your wallet.",
    ]);
  }, 15_000);

  it("two partners", async () => {
    const { push } = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push(late([{ name: "Tess Partner", n: 7 }, { name: "Sam Partner", n: 7 }], 6, 30));
    await wait(400);
    expect(toasts()).toEqual([
      "Your booking on Court 3 · Mon 7 Oct was cancelled: 30 minutes came back, 7 minutes went back to Tess and 7 minutes to Sam for their shares, 6 minutes went on a late-cancellation charge, so 10 minutes came back to your wallet.",
    ]);
  }, 15_000);

  it("a mixed frame with no share rows keeps its own sentence", async () => {
    const { push } = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push({ balance_minutes: 211, delta_minutes: 11, reason: "mixed", parts: [{ reason: "cancellation_refund", delta_minutes: 15 }, { reason: "penalty", delta_minutes: -4 }] });
    await wait(400);
    expect(toasts()).toEqual(["15 minutes came back and 4 minutes went on a charge, so 11 minutes came back to your wallet."]);
  }, 15_000);
});

describe("R14 E14-5 (BE14b §5) — the club cancels a session that had started: nothing moved, but it is said", () => {
  const said = () => [...document.querySelectorAll("[role=status]")].map((n) => n.textContent ?? "").filter((t) => /cancelled your session/.test(t));

  it("a balance-neutral cancelled_no_refund frame raises one toast with court, day and time", async () => {
    const { push } = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push({ balance_minutes: 200, delta_minutes: 0, reason: "cancelled_no_refund", parts: [], cancelled_by: "club", share_cause: null, ...PLACE });
    await wait(400);
    expect(said()).toEqual(["The club cancelled your session on Court 3 · Mon 7 Oct, 18:00 — it had started, so nothing was refunded."]);
  }, 15_000);

  it("any other zero-minute frame stays silent", async () => {
    const { push } = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push({ balance_minutes: 200, delta_minutes: 0, reason: "cancellation_refund", parts: [], ...PLACE });
    await wait(400);
    expect([...document.querySelectorAll("[role=status]")].map((n) => n.textContent ?? "").filter((t) => /Court 3/.test(t))).toEqual([]);
  }, 15_000);
});

describe("R14 §9 — club_settled and share_back: the record's cause, nobody named who did not act", () => {
  const out = { from: "Omar Organiser", to: "Sam Partner", actorUserId: SAM, actorName: "Sam Partner" };
  const part = (name: string, n: number) => ({ reason: "share_transfer", delta_minutes: n, counterparty_name: name });

  // R16 J16-6 — a by-hand payment to the organiser, said as who paid whom.
  it("partner, club_settled (plain): '… of your share of Court 3 · Mon 7 Oct came back — the club recorded that you paid Omar by hand.'", async () => {
    expect(await share([GONE], 7, { share_cause: "club_settled", actor_name: null, parts: [part("Omar Organiser", 7)] }))
      .toEqual(["7 minutes of your share of Court 3 · Mon 7 Oct came back — the club recorded that you paid Omar by hand."]);
  }, 15_000);

  it("partner, club_settled (booking readable, named path): the same words", async () => {
    const readable = { path: `/api/v1/bookings/${BOOKING}`, body: { ...detail([]), organiser: { user_id: OMAR, name: "Omar Organiser", photo_url: null } } };
    expect(await share([readable], 7, { share_cause: "club_settled", actor_name: null }))
      .toEqual(["7 minutes of your share of Court 3 · Mon 7 Oct came back — the club recorded that you paid Omar by hand."]);
  }, 15_000);

  it("organiser, club_settled, one partner: '7 minutes went back to Sam — the club recorded that Sam paid you by hand for ….'", async () => {
    expect(await share([GONE], -7, { share_cause: "club_settled", actor_name: null, parts: [part("Sam Partner", -7)] }, out))
      .toEqual(["7 minutes went back to Sam — the club recorded that Sam paid you by hand for Court 3 · Mon 7 Oct."]);
  }, 15_000);

  it("organiser, club_settled, two partners in one frame: both named, plural", async () => {
    expect(await share([GONE], -14, { share_cause: "club_settled", actor_name: null, parts: [part("Sam Partner", -7), part("Nomsa Dube", -7)] }, out))
      .toEqual(["14 minutes went back to Sam and Nomsa — the club recorded that they paid you by hand for Court 3 · Mon 7 Oct."]);
  }, 15_000);

  it("partner, share_back: plain, nobody named", async () => {
    const said = await share([GONE], 16, { share_cause: "share_back", actor_name: null, parts: [part("Omar Organiser", 16)] });
    expect(said).toEqual(["16 minutes of your share of Court 3 · Mon 7 Oct came back."]);
  }, 15_000);

  it("organiser, share_back, one and two partners: who it went back to, never who did it", async () => {
    expect(await share([GONE], -16, { share_cause: "share_back", actor_name: null, parts: [part("Sam Partner", -16)] }, out))
      .toEqual(["16 minutes went back to Sam from their share of Court 3 · Mon 7 Oct."]);
  }, 15_000);

  it("organiser, share_back, two partners", async () => {
    expect(await share([GONE], -20, { share_cause: "share_back", actor_name: null, parts: [part("Sam Partner", -10), part("Nomsa Dube", -10)] }, out))
      .toEqual(["20 minutes went back to Sam and Nomsa from their shares of Court 3 · Mon 7 Oct."]);
  }, 15_000);

  it("share_paid with actor_name null, both sides: no 'null', no empty name", async () => {
    for (const [signed, row] of [[7, {}], [-7, out]] as const) {
      const said = await share([GONE], signed, { share_cause: "share_paid", actor_name: null }, row);
      expect(said).toHaveLength(1);
      expect(said[0]).not.toMatch(/null|undefined| {2}|^ | paid you|\bby\s*[—.]/);
      document.body.innerHTML = "";
    }
  }, 30_000);
});
