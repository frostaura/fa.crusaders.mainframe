import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import type { BalanceFrame, BalanceTransport } from "@/lib/liveBalance";
import { shareMovementPlain } from "@/lib/shareMovementCopy";
import { ToastProvider } from "../Toast";
import { MinutesChip } from "../shell/MinutesChip";
import { signIn, signOut, stubFetch } from "../../test/harness";

/** R19 X19-3 — a toast is `[data-toast]` (no live role of its own); any other status region still counts. */
const SAID = "[role=status], [data-toast]";

/**
 * Review round 16 (FE16m) — the chip's toasts against BE16b's R16 frames.
 *
 * <ul>
 *   <li><b>J16-7</b> — the club cancelled a split session that had started: the organiser heard
 *   "nothing was refunded", the partner got a balance-neutral frame and NO toast. The partner's
 *   frame is now `cancelled_share_stands`, said: "The club cancelled Court 3 · … — it had started,
 *   so your share stands."</li>
 *   <li><b>J16-6</b> — a share returned because the club recorded a by-hand payment says who paid
 *   whom: "the club recorded that you paid Omar by hand".</li>
 * </ul>
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); localStorage.clear(); });

const PLACE = { court_name: "Court 3", booking_starts_at: "2030-10-07T16:00:00Z" };

function mount() {
  const whoami = signIn({ isAdmin: false });
  stubFetch([
    { path: "/api/v1/whoami", body: whoami },
    { path: "/api/v1/wallet", body: { balance_minutes: 200, entries: [], total_entries: 0, offset: 0, limit: 100 } },
  ]);
  let live: { onFrame: (f: BalanceFrame) => void } | null = null;
  const transport: BalanceTransport = { open: (args) => { live = args; return Promise.resolve({ close: () => { live = null; } }); } };
  render(<MemoryRouter><AuthProvider><BalanceProvider transport={transport}><ToastProvider><MinutesChip /></ToastProvider></BalanceProvider></AuthProvider></MemoryRouter>);
  return (f: BalanceFrame) => act(async () => { live?.onFrame(f); });
}

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const said = () => [...document.querySelectorAll(SAID)].map((n) => n.textContent ?? "").filter((t) => /Court 3/.test(t));

describe("R16 J16-7 — the partner of a started game the club cancelled hears that their share stands", () => {
  it("one toast, with the court, day and time", async () => {
    const push = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push({ balance_minutes: 200, delta_minutes: 0, reason: "cancelled_share_stands", parts: [], cancelled_by: "club", share_cause: null, ...PLACE });
    await wait(400);
    expect(said()).toEqual(["The club cancelled Court 3 · Mon 7 Oct, 18:00 — it had started, so your share stands."]);
  }, 15_000);

  it("unplaced (no court on the frame): still said", async () => {
    const push = mount();
    await push({ balance_minutes: 200 });
    await wait(120);
    await push({ balance_minutes: 200, delta_minutes: 0, reason: "cancelled_share_stands", parts: [], cancelled_by: "club" });
    await wait(400);
    const all = [...document.querySelectorAll(SAID)].map((n) => n.textContent ?? "");
    expect(all).toContain("The club cancelled your game — it had started, so your share stands.");
  }, 15_000);
});

describe("R16 J16-6 — a share back because the club recorded a by-hand payment", () => {
  const COURT = { courtName: "Court 3", startsAt: "2030-10-07T16:00:00Z" };
  const AT = "Court 3 · Mon 7 Oct";

  it("the partner: who they paid", () => {
    expect(shareMovementPlain(7, "club_settled", undefined, undefined, { place: COURT, other: "Omar Organiser" }))
      .toBe(`7 minutes of your share of ${AT} came back — the club recorded that you paid Omar by hand.`);
    expect(shareMovementPlain(7, "club_settled", undefined, undefined, { place: COURT }))
      .toBe(`7 minutes of your share of ${AT} came back — the club recorded that you paid the organiser by hand.`);
  });

  it("the organiser: who paid them", () => {
    expect(shareMovementPlain(-7, "club_settled", undefined, undefined, { place: COURT, others: ["Sam Partner"] }))
      .toBe(`7 minutes went back to Sam — the club recorded that Sam paid you by hand for ${AT}.`);
    expect(shareMovementPlain(-14, "club_settled", undefined, undefined, { place: COURT, others: ["Sam Partner", "Nomsa Khumalo"] }))
      .toBe(`14 minutes went back to Sam and Nomsa — the club recorded that they paid you by hand for ${AT}.`);
  });
});
