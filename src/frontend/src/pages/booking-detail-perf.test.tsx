import { afterEach, beforeEach, describe, expect, it as vitestIt, vi } from "vitest";
import { settledIt } from "@/test/settled";
import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderPage, signOut } from "@/test/harness";
import { RESULT_READABLE } from "@/lib/bookingLink";
import { RESULT_CARD } from "@/lib/playCopy";
import BookingDetailPage from "./BookingDetail";
import { BOOKING, DETAIL_PATH, renderDetail, serve } from "@/components/players/__tests__/detailKit";


// FM-7: every test here waits for the screen it drew to settle before it ends.
const it = settledIt(vitestIt);

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * Perf lane (2026-09-30) — the booking page reads its result card's route BESIDE the booking,
 * not a round trip after it, and still reads it once.
 */
beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

/** Opened from a link that knew the game is live — the upcoming list, the grid, the confirmation. */
function renderFromLiveLink() {
  return renderPage(
    <Routes><Route path="/bookings/:bookingId" element={<BookingDetailPage />} /></Routes>,
    { initialEntries: [{ pathname: `/bookings/${BOOKING}`, state: RESULT_READABLE }], reactStrictMode: true },
  );
}

/** Holds the booking's own read until `release()`; everything else answers as served. */
function holdDetail() {
  const answered = globalThis.fetch;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    (String(input) === DETAIL_PATH ? gate.then(() => answered(input, init)) : answered(input, init)));
  return () => release();
}

describe("booking detail — the result read", () => {
  it("is sent while the booking is still being read, and only once, from a link that vouched", async () => {
    const stub = serve();
    const release = holdDetail();
    renderFromLiveLink();
    const resultCalls = () => stub.calls.filter((c) => c.path === `${DETAIL_PATH}/result`);
    await waitFor(() => expect(resultCalls()).toHaveLength(1));
    expect(screen.queryByRole("heading", { level: 1, name: /Court 1/ })).not.toBeInTheDocument();

    release();
    await screen.findByRole("heading", { level: 1, name: /Court 1/ });
    expect(await screen.findByRole("region", { name: RESULT_CARD.title })).toBeInTheDocument();
    expect(resultCalls()).toHaveLength(1);
  });

  it("waits for the booking when nothing vouched the game is live — a cancelled one asks for none (F2.15)", async () => {
    const stub = serve();
    const release = holdDetail();
    renderDetail();
    await waitFor(() => expect(stub.calls.some((c) => c.path === "/api/v1/whoami")).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(stub.calls.filter((c) => c.path === `${DETAIL_PATH}/result`)).toHaveLength(0);
    release();
  });

  it("is not sent early for an admin, who is shown no result on another member's game", async () => {
    const stub = serve({ admin: true });
    const release = holdDetail();
    renderFromLiveLink();
    await waitFor(() => expect(stub.calls.some((c) => c.path === "/api/v1/whoami")).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(stub.calls.filter((c) => c.path === `${DETAIL_PATH}/result`)).toHaveLength(0);
    release();
  });
});
