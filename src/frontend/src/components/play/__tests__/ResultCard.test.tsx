import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { refuse, renderPage, signOut } from "@/test/harness";
import { ResultCard } from "@/components/play/ResultCard";
import {
  CONFIRM_SHEET, GAME_REASON, PLAY_REFUSAL, RESULT_CARD, RESULT_SHEET, STATUS_WORD,
} from "@/lib/playCopy";
import { BOOKING, GUEST, RESULT_PATH, result, samView, serve, submitterView, view } from "./playKit";

/**
 * The result on a booking (§9.2) in every status and every hand the server gives the viewer,
 * the deep link from the mail, and the sheets' round trips — the request each one SENDS, not
 * only what the card says afterwards.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

function renderCard(search = "") {
  return renderPage(
    <Routes>
      <Route path="/bookings/:bookingId" element={<><ResultCard bookingId={BOOKING} /><Where /></>} />
    </Routes>,
    { initialEntries: [`/bookings/${BOOKING}${search}`] },
  );
}

const card = () => document.querySelector("[data-result-card]") as HTMLElement;

describe("reading", () => {
  it("shows a skeleton, then the record button when the viewer can record", async () => {
    serve([{ path: RESULT_PATH, body: view() }]);
    renderCard();
    expect(await screen.findByRole("button", { name: RESULT_CARD.record })).toBeInTheDocument();
    expect(card()).toHaveTextContent(RESULT_CARD.noneYet);
  });

  it("says why a result cannot be recorded yet, with no button", async () => {
    serve([{ path: RESULT_PATH, body: view({ permissions: { ...view().permissions, can_record: false }, not_recordable_reason: "not_checked_in" }) }]);
    renderCard();
    expect(await screen.findByText(RESULT_CARD.notCheckedIn)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: RESULT_CARD.record })).toBeNull();
  });

  it("says a checked-in court whose time has not begun as not started (B15), with no button", async () => {
    serve([{ path: RESULT_PATH, body: view({ permissions: { ...view().permissions, can_record: false }, not_recordable_reason: "not_started" }) }]);
    renderCard();
    expect(await screen.findByText(RESULT_CARD.notStarted)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: RESULT_CARD.record })).toBeNull();
  });

  it("says a failed read as a failure with a retry — never as 'no result'", async () => {
    // The first read never reaches the club (a phone in a lift); the retry does.
    let calls = 0;
    serve([{ path: RESULT_PATH, respond: () => { calls += 1; if (calls === 1) throw new TypeError("Failed to fetch"); return view(); } }]);
    renderCard();
    const retry = await screen.findByRole("button", { name: /try again/i });
    expect(card()).not.toHaveTextContent(RESULT_CARD.noneYet);
    fireEvent.click(retry);
    expect(await screen.findByRole("button", { name: RESULT_CARD.record })).toBeInTheDocument();
  });

  it("draws nothing for a viewer the server says is not a player (404)", async () => {
    const stub = serve([{ path: RESULT_PATH, status: 404, body: { error: "booking_not_found" } }]);
    renderCard();
    await waitFor(() => expect(stub.calls.some((c) => c.path === RESULT_PATH)).toBe(true));
    await waitFor(() => expect(card()).toBeNull());
  });

  it("reads a 404 result_not_found as 'no result yet', never as a hidden card", async () => {
    serve([{ path: RESULT_PATH, status: 404, body: { error: "result_not_found" } }]);
    renderCard();
    expect(await screen.findByText(RESULT_CARD.noneYet)).toBeInTheDocument();
    expect(card()).not.toBeNull();
  });
});

describe("every status", () => {
  it("pending, to the submitter: the score, who it waits for, and edit / withdraw", async () => {
    serve([{ path: RESULT_PATH, body: submitterView() }]);
    renderCard();
    expect(await screen.findByText(STATUS_WORD.pending)).toBeInTheDocument();
    expect(card()).toHaveTextContent(/Waiting for Sam Petersen to confirm · confirms itself Fri 2 Oct, 19:00/);
    expect(screen.getByRole("button", { name: RESULT_CARD.edit })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: RESULT_CARD.withdraw })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: RESULT_CARD.confirm })).toBeNull();
    // The scoreboard: a real table, the winner marked in words as well as by a trophy.
    const table = screen.getByRole("table");
    expect(within(table).getByRole("rowheader", { name: /Nomsa Khumalo \(you\).*\(won\)/ })).toBeInTheDocument();
  });

  it("pending, to the confirming side: confirm and something's wrong", async () => {
    serve([{ path: RESULT_PATH, body: samView() }]);
    renderCard();
    expect(await screen.findByRole("button", { name: RESULT_CARD.confirm })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: RESULT_CARD.somethingWrong })).toBeInTheDocument();
    expect(card()).toHaveTextContent(RESULT_CARD.waitingForYou);
    expect(screen.queryByRole("button", { name: RESULT_CARD.edit })).toBeNull();
  });

  it("a side of guests alone is 'the other side', since a guest cannot confirm", async () => {
    serve([{ path: RESULT_PATH, body: submitterView({ result: result({ sides: { a: [submitterView().result!.sides.a[0]], b: [GUEST] } }) }) }]);
    renderCard();
    expect(await screen.findByText(/Waiting for the other side to confirm/)).toBeInTheDocument();
  });

  it("disputed: the words, who disputed, and the note", async () => {
    const disputed = result({ status: "disputed", disputed_by: { user_id: "x", name: "Sam Petersen" }, dispute_note: "It was 3–2." });
    serve([{ path: RESULT_PATH, body: view({ result: disputed, permissions: { ...view().permissions, can_record: false } }) }]);
    renderCard();
    expect(await screen.findByText(RESULT_CARD.disputed)).toBeInTheDocument();
    expect(card()).toHaveTextContent(RESULT_CARD.disputedBy("Sam Petersen"));
    expect(document.querySelector("[data-dispute-note]")).toHaveTextContent("It was 3–2.");
  });

  it("confirmed automatically: said as such, with the viewer's own outcome", async () => {
    const confirmed = result({ status: "confirmed", auto_confirmed: true, confirmed_at: "2026-10-02T17:00:00Z" });
    serve([{ path: RESULT_PATH, body: view({ result: confirmed, permissions: { ...view().permissions, can_record: false } }) }]);
    renderCard();
    expect(await screen.findByText(RESULT_CARD.confirmedAuto)).toBeInTheDocument();
    expect(card()).toHaveTextContent(`${RESULT_CARD.youWon} 3–1`);
  });

  it("voided: the club removed it, and it can be recorded again while the window is open", async () => {
    serve([{ path: RESULT_PATH, body: view({ result: result({ status: "voided", closed_by_admin: true }) }) }]);
    renderCard();
    expect(await screen.findByText(RESULT_CARD.voided)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: RESULT_CARD.record })).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("confirm and dispute", () => {
  it("confirms from the card with the version it was shown", async () => {
    const stub = serve([
      { path: RESULT_PATH, body: null, sequence: [samView(), view({ result: result({ status: "confirmed" }), permissions: { ...view().permissions, can_record: false } })] },
      { method: "POST", path: `${RESULT_PATH}/confirm`, body: result({ status: "confirmed", viewer_side: "b", viewer_outcome: "lost" }) },
    ]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: RESULT_CARD.confirm }));
    expect(await screen.findByText(RESULT_CARD.confirmed)).toBeInTheDocument();
    const post = stub.calls.find((c) => c.method === "POST" && c.path === `${RESULT_PATH}/confirm`);
    expect(post?.body).toEqual({ expectedVersion: 1 });
  });

  it("disputes with a note through the sheet", async () => {
    const stub = serve([
      { path: RESULT_PATH, body: samView() },
      { method: "POST", path: `${RESULT_PATH}/dispute`, body: result({ status: "disputed", dispute_note: "3–2" }) },
    ]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: RESULT_CARD.somethingWrong }));
    const dialog = await screen.findByRole("dialog", { name: CONFIRM_SHEET.title });
    fireEvent.change(within(dialog).getByLabelText(CONFIRM_SHEET.noteLabel), { target: { value: "It was 3–2." } });
    fireEvent.click(within(dialog).getByRole("button", { name: CONFIRM_SHEET.send }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const post = stub.calls.find((c) => c.method === "POST" && c.path === `${RESULT_PATH}/dispute`);
    expect(post?.body).toEqual({ expectedVersion: 1, note: "It was 3–2." });
  });

  it("a changed result is said, and the card re-reads", async () => {
    const stub = serve([
      { path: RESULT_PATH, body: samView() },
      { method: "POST", path: `${RESULT_PATH}/confirm`, status: 409, body: { error: "result_changed", version: 2, status: "pending" } },
    ]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: RESULT_CARD.confirm }));
    expect(await screen.findByText(PLAY_REFUSAL.result_changed)).toBeInTheDocument();
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "GET" && c.path === RESULT_PATH).length).toBeGreaterThan(1));
  });
});

describe("the mail's deep link", () => {
  it("?result=confirm opens the confirm sheet, and closing it drops the query", async () => {
    serve([{ path: RESULT_PATH, body: samView() }]);
    renderCard("?result=confirm");
    const dialog = await screen.findByRole("dialog", { name: CONFIRM_SHEET.title });
    expect(within(dialog).getByRole("table")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Close / }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("where")).toHaveTextContent(`/bookings/${BOOKING}`);
    expect(screen.getByTestId("where").textContent).not.toContain("result=");
  });

  it("?result=confirm on a result already settled simply shows the card", async () => {
    serve([{ path: RESULT_PATH, body: view({ result: result({ status: "confirmed" }), permissions: { ...view().permissions, can_record: false } }) }]);
    renderCard("?result=confirm");
    expect(await screen.findByText(RESULT_CARD.confirmed)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("R1 F2.11: ?result=confirm on a result that was withdrawn says there is nothing to confirm", async () => {
    serve([{ path: RESULT_PATH, body: view({ result: null }) }]);
    renderCard("?result=confirm");
    expect(await screen.findByText(RESULT_CARD.confirmGone(null))).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("R1 F2.11: ?result=confirm on a result the other side already confirmed says so", async () => {
    serve([{ path: RESULT_PATH, body: view({ result: result({ status: "confirmed" }), permissions: { ...view().permissions, can_record: false } }) }]);
    renderCard("?result=confirm");
    expect(await screen.findByText(RESULT_CARD.confirmGone("confirmed"))).toBeInTheDocument();
  });

  it("?result=record opens the record sheet", async () => {
    serve([{ path: RESULT_PATH, body: view() }]);
    renderCard("?result=record");
    expect(await screen.findByRole("dialog", { name: RESULT_SHEET.title })).toBeInTheDocument();
  });
});

describe("withdraw", () => {
  it("asks first, with an outcome-named way out, then withdraws with the version", async () => {
    const stub = serve([
      { path: RESULT_PATH, body: submitterView() },
      { method: "POST", path: `${RESULT_PATH}/withdraw`, body: result({ status: "withdrawn" }) },
    ]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: RESULT_CARD.withdraw }));
    const dialog = screen.getByRole("dialog", { name: RESULT_CARD.withdrawTitle });
    expect(within(dialog).getByRole("button", { name: RESULT_CARD.withdrawKeep })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: RESULT_CARD.withdraw }));
    expect(await screen.findByText(RESULT_CARD.withdrawnStatus)).toBeInTheDocument();
    expect(stub.calls.find((c) => c.path === `${RESULT_PATH}/withdraw`)?.body).toEqual({ expectedVersion: 1 });
  });
});

describe("a refusal from the server reads like the live check", () => {
  it("score_invalid is the same sentence the row shows", async () => {
    serve([
      { path: RESULT_PATH, body: view() },
      { method: "POST", path: RESULT_PATH, respond: () => refuse(400, { error: "score_invalid", game_index: 0, reason: "overrun" }) },
    ]);
    renderCard("?result=record");
    const dialog = await screen.findByRole("dialog", { name: RESULT_SHEET.title });
    const boxes = within(dialog).getAllByRole("textbox");
    // Three straight 11–0 games: the sheet is satisfied; the server is not (a stub on purpose).
    for (let g = 0; g < 3; g += 1) {
      fireEvent.change(within(dialog).getAllByRole("textbox")[g * 2], { target: { value: "11" } });
      fireEvent.change(within(dialog).getAllByRole("textbox")[g * 2 + 1], { target: { value: "0" } });
    }
    expect(boxes.length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole("button", { name: RESULT_SHEET.submit }));
    expect(await within(dialog).findByText(`Game 1: ${GAME_REASON.overrun}`)).toBeInTheDocument();
  });

  it("result_not_recordable with not_started (B15) says the court time has not begun", async () => {
    serve([
      { path: RESULT_PATH, body: view() },
      { method: "POST", path: RESULT_PATH, respond: () => refuse(409, { error: "result_not_recordable", reason: "not_started" }) },
    ]);
    renderCard("?result=record");
    const dialog = await screen.findByRole("dialog", { name: RESULT_SHEET.title });
    for (let g = 0; g < 3; g += 1) {
      fireEvent.change(within(dialog).getAllByRole("textbox")[g * 2], { target: { value: "11" } });
      fireEvent.change(within(dialog).getAllByRole("textbox")[g * 2 + 1], { target: { value: "0" } });
    }
    fireEvent.click(within(dialog).getByRole("button", { name: RESULT_SHEET.submit }));
    expect(await within(dialog).findByText(RESULT_CARD.notStarted)).toBeInTheDocument();
  });
});
