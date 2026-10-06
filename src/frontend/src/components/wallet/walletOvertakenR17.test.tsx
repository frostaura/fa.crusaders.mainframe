import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "@/lib/auth";
import { BalanceProvider } from "@/lib/balance";
import { useBalance } from "@/lib/useBalance";
import type { BalanceFrame, BalanceTransport } from "@/lib/liveBalance";
import { memberReads } from "@/lib/offline/memberReads";
import { fetchQuery } from "@/lib/offline/queryCache";
import WalletPage from "@/pages/Wallet";
import { ToastProvider } from "../Toast";
import { MinutesChip } from "../shell/MinutesChip";
import { signIn, signOut } from "../../test/harness";

/** R19 X19-3 — a toast is `[data-toast]` (no live role of its own); any other status region still counts. */
const SAID = "[role=status], [data-toast]";

/**
 * R17 J17-2 follow-through (lane FE17x) — the wallet page hands its own read to the live balance
 * (`apply`) so a Refresh can end a stale chip. Its first read JOINS a read already out for the same
 * page (the route's early read, or the page's own earlier one), and that read may have been SENT
 * before a stream frame landed. Its time-based guard measured the page's ask, not the send: the
 * joined answer's older figure went over the frame's newer one and the page announced a movement
 * that never happened ("50 minutes arrived" after the club took 50). A joined or overtaken answer
 * is never applied, and when its figure disagrees with the live one the page reads again so the
 * ledger rows match the card.
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); localStorage.clear(); });

const USER = "44444444-4444-4444-4444-444444444444";
const ROW = {
  id: "r9", at: "2026-10-06T08:00:00Z", from: "Thandi Probe", to: "Club",
  amountMinutes: 50, signedAmountMinutes: -50, type: "AdminAdjustment", comment: "Desk",
  subjectUserId: USER, subjectName: "Thandi Probe", actorUserId: "u-admin", actorName: "Xavi Adminworth", relatedBookingId: null,
};

type Held = { path: string; answer: (body: unknown) => void };

/** whoami answers at once; every wallet read waits for the test. */
function network() {
  const whoami = signIn({ isAdmin: false });
  const held: Held[] = [];
  const reply = (body: unknown) => {
    const wire = JSON.stringify(body);
    return { ok: true, status: 200, headers: { get: () => null }, text: () => Promise.resolve(wire), json: () => Promise.resolve(JSON.parse(wire)) } as unknown as Response;
  };
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : input.toString();
    if (path.startsWith("/api/v1/whoami")) return Promise.resolve(reply(whoami));
    if (path.startsWith("/api/v1/wallet")) return new Promise((resolve) => { held.push({ path, answer: (b) => resolve(reply(b)) }); });
    return Promise.reject(new Error(`No stub for ${path}`));
  }));
  const page = (balance: number, entries: unknown[] = []) => ({ balance_minutes: balance, entries, total_entries: entries.length, offset: 0, limit: 20 });
  /** Answers the oldest held read whose path matches. */
  const answer = (match: (p: string) => boolean, body: unknown) => act(async () => {
    const at = held.findIndex((h) => match(h.path));
    expect(at, "a held wallet read").toBeGreaterThanOrEqual(0);
    held.splice(at, 1)[0].answer(body);
  });
  return { held, page, answer };
}

const isChip = (p: string) => p.includes("limit=1&") || p.endsWith("limit=1");
const isPage = (p: string) => p.includes("share_bookings");
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 120)); });

/** What the test reads off the tree: the provider's live figure, and the switch that opens the page. */
const probe: { show: (() => void) | null; live: number | null } = { show: null, live: null };

function Shell() {
  const [on, setOn] = useState(false);
  const { balance } = useBalance();
  useEffect(() => { probe.show = () => setOn(true); probe.live = balance; });
  return <>{on ? <WalletPage /> : null}</>;
}

function mount() {
  let live: { onFrame: (f: BalanceFrame) => void } | null = null;
  const transport: BalanceTransport = { open: (args) => { live = args; return Promise.resolve({ close: () => { live = null; } }); } };
  render(
    <MemoryRouter initialEntries={["/wallet"]}>
      <AuthProvider>
        <BalanceProvider transport={transport}>
          <ToastProvider><MinutesChip /><Shell /></ToastProvider>
        </BalanceProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { push: (f: BalanceFrame) => act(async () => { live?.onFrame(f); }) };
}

const statuses = () => [...document.querySelectorAll(SAID)].map((n) => n.textContent ?? "");

describe("the wallet page never puts an overtaken read over a newer frame (R17 J17-2, FE17x)", () => {
  it("early read sent → the club takes 50 (frame) → the page opens and joins it → old 200 lands: 150 stands, no 'arrived', and it reads again", async () => {
    const net = network();
    const { push } = mount();
    await settle();
    await net.answer(isChip, net.page(200));
    await settle();
    expect(probe.live).toBe(200);
    // The route's early read for /wallet goes out while the balance is still 200…
    void fetchQuery(USER, memberReads.wallet.key, memberReads.wallet.load);
    await settle();
    // …the club takes 50 while it is out…
    await push({ balance_minutes: 150, delta_minutes: -50, reason: "admin_adjustment" });
    await settle();
    // …and the page opens, joining the read that predates the frame.
    await act(async () => { probe.show?.(); });
    await settle();
    await net.answer(isPage, net.page(200));
    await settle(); await settle();
    expect(probe.live).toBe(150);
    expect(statuses().some((t) => /arrived|added|went up/i.test(t))).toBe(false);
    // The rows it holds are older than the card: it asks the club again, and that read is believed.
    expect(net.held.some((h) => isPage(h.path))).toBe(true);
    await net.answer(isPage, net.page(150, [ROW]));
    await settle(); await settle();
    expect(probe.live).toBe(150);
    // The believed read agrees with the live figure: no further read, no loop.
    expect(net.held.some((h) => isPage(h.path))).toBe(false);
    expect(statuses().some((t) => /arrived|added|went up/i.test(t))).toBe(false);
  });

  it("the reverse: the page's own read lands before any frame and is taken; the frame after it moves the figure once", async () => {
    const net = network();
    const { push } = mount();
    await settle();
    await net.answer(isChip, net.page(200));
    await act(async () => { probe.show?.(); });
    await settle();
    await net.answer(isPage, net.page(200));
    await settle();
    expect(probe.live).toBe(200);
    await push({ balance_minutes: 150, delta_minutes: -50, reason: "admin_adjustment" });
    await settle();
    expect(probe.live).toBe(150);
    // The frame's re-read of the ledger lands with the row; nothing says money arrived.
    if (net.held.some((h) => isPage(h.path))) await net.answer(isPage, net.page(150, [ROW]));
    await settle(); await settle();
    expect(probe.live).toBe(150);
    expect(statuses().some((t) => /arrived|added|went up/i.test(t))).toBe(false);
  });
});
