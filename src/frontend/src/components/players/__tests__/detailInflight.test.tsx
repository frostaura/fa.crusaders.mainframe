import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useNavigate } from "react-router-dom";
import BookingDetailPage from "@/pages/BookingDetail";
import { renderPage, signOut } from "@/test/harness";
import { CHANGE_SPLIT, DETAIL_ACTIONS } from "@/lib/playersCopy";
import { ALEX_SEAT, BOOKING, DETAIL_PATH, OPEN_SEAT, PID, detail, seat, serve } from "./detailKit";

/**
 * R5 I5-2 — Remove player and Change split on the booking page stay open while their write is on
 * its way: the system Back is refused (and said), and an answer that lands after the page has gone
 * is said in a toast rather than in a page notice that died with it.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const SPLIT = `${DETAIL_PATH}/split`;
const PREVIEW = "/api/v1/players/split-preview";
const notice = () => document.querySelector("[data-detail-notice]");

/** Every write with this method is held until the test answers it; reads answer at once. */
function hold(method: string) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    ((init?.method ?? "GET").toUpperCase() === method ? gate.then(() => inner(input, init)) : inner(input, init)));
  return { answer: () => act(async () => { release(); await gate; await new Promise((r) => setTimeout(r, 0)); }) };
}

/** The system Back, and a forced route away (a sign-out, a route the shell forces). */
function Controls() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate(-1)}>system back</button>
      <button type="button" onClick={() => navigate("/elsewhere")}>forced away</button>
    </>
  );
}

function renderWithBack() {
  return renderPage(
    <>
      <Controls />
      <Routes>
        <Route path="/bookings/:bookingId" element={<BookingDetailPage />} />
        <Route path="/bookings" element={<p>The bookings grid</p>} />
        <Route path="/elsewhere" element={<p>Somewhere else</p>} />
      </Routes>
    </>,
    { initialEntries: ["/bookings", `/bookings/${BOOKING}`], reactStrictMode: true },
  );
}

const back = () => act(async () => { fireEvent.click(screen.getByText("system back")); });

function previewOf({ body }: { body: unknown }) {
  const req = body as { priceMinutes: number; players: { seat: number; amount?: number }[] };
  const partners = req.players.map((p) => ({ seat: p.seat, team: p.seat <= 2 ? "A" : "B", share_minutes: p.amount ?? 25, weight: 1 }));
  const taken = partners.reduce((n, p) => n + p.share_minutes, 0);
  return { price_minutes: req.priceMinutes, shares: [{ seat: 1, team: "A", share_minutes: req.priceMinutes - taken, weight: 1 }, ...partners] };
}

describe("Remove player (I5-2)", () => {
  const withoutSam = detail({ players: [seat(), ALEX_SEAT, OPEN_SEAT] });

  function serveRemove() {
    let current = detail();
    serve({
      detail: { path: DETAIL_PATH, respond: () => current },
      extra: [{ method: "DELETE", path: `${DETAIL_PATH}/players/${PID.sam}`, respond: () => { current = withoutSam; return { ok: true }; } }],
    });
    return hold("DELETE");
  }

  async function pressRemove() {
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.removeFor("Sam") }));
    const dialog = await screen.findByRole("dialog", { name: DETAIL_ACTIONS.removeTitle("Sam") });
    fireEvent.click(within(dialog).getByRole("button", { name: DETAIL_ACTIONS.removeConfirm }));
    return dialog;
  }

  it("refuses the system Back while the remove is on its way, then says it on the page", async () => {
    const slow = serveRemove();
    renderWithBack();
    const dialog = await pressRemove();
    expect(within(dialog).getByText(DETAIL_ACTIONS.removeSending)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: DETAIL_ACTIONS.removeKeep })).toBeNull();
    await back();
    expect(screen.queryByText("The bookings grid")).toBeNull();
    expect(screen.getByRole("dialog", { name: DETAIL_ACTIONS.removeTitle("Sam") })).toBeInTheDocument();
    // Escape is refused too.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog", { name: DETAIL_ACTIONS.removeTitle("Sam") })).toBeInTheDocument();
    await slow.answer();
    await waitFor(() => expect(notice()).toHaveTextContent(DETAIL_ACTIONS.removed("Sam")));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The dialog's history entry is gone with it: the next Back leaves the page as it would have.
    await back();
    await waitFor(() => expect(screen.getByText("The bookings grid")).toBeInTheDocument());
  });

  it("Back closes the dialog when nothing is on its way, and stays on the page", async () => {
    serveRemove();
    renderWithBack();
    fireEvent.click(await screen.findByRole("button", { name: DETAIL_ACTIONS.removeFor("Sam") }));
    await screen.findByRole("dialog", { name: DETAIL_ACTIONS.removeTitle("Sam") });
    await back();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("The bookings grid")).toBeNull();
  });

  it("an answer that lands after the page was torn down is said in a toast", async () => {
    const slow = serveRemove();
    renderWithBack();
    await pressRemove();
    fireEvent.click(screen.getByText("forced away"));
    await screen.findByText("Somewhere else");
    await slow.answer();
    expect(await screen.findByText(DETAIL_ACTIONS.removed("Sam"))).toBeInTheDocument();
  });
});

describe("Change split (I5-2)", () => {
  it("refuses the system Back while the save is on its way, then says it on the page", async () => {
    serve({ extra: [
      { method: "POST", path: PREVIEW, respond: previewOf },
      { method: "PUT", path: SPLIT, body: { booking_id: BOOKING, split_mode: "equal", shares: [] } },
    ] });
    const slow = hold("PUT");
    renderWithBack();
    fireEvent.click(await screen.findByRole("button", { name: CHANGE_SPLIT.open }));
    const dialog = await screen.findByRole("dialog", { name: CHANGE_SPLIT.title });
    const save = within(dialog).getByRole("button", { name: CHANGE_SPLIT.save });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(await within(dialog).findByText(CHANGE_SPLIT.sending)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: CHANGE_SPLIT.cancel })).toBeNull();
    await back();
    expect(screen.queryByText("The bookings grid")).toBeNull();
    expect(screen.getByRole("dialog", { name: CHANGE_SPLIT.title })).toBeInTheDocument();
    await slow.answer();
    await waitFor(() => expect(notice()).toHaveTextContent(CHANGE_SPLIT.done));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
