import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { refuse, renderPage, signOut } from "@/test/harness";
import { ResultCard } from "@/components/play/ResultCard";
import type { BookingResultView } from "@/lib/playApi";
import { CONFIRM_SHEET, RESULT_CARD, RESULT_LOST, RESULT_SHEET, RESULT_UNSURE } from "@/lib/playCopy";
import { BOOKING, RESULT_PATH, SAM, result, samView, serve, submitterView, view } from "./playKit";

/**
 * R3 I-1 — a result write whose reply was lost. The stub PERFORMS the write (the club's record
 * moves) and then loses the reply (504, or a dropped connection): the card reads the result back
 * and says what it finds — never "Couldn't record" over a result that stands.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

function renderCard() {
  return renderPage(
    <Routes><Route path="/bookings/:bookingId" element={<ResultCard bookingId={BOOKING} />} /></Routes>,
    { initialEntries: [`/bookings/${BOOKING}`] },
  );
}

const card = () => document.querySelector("[data-result-card]") as HTMLElement;
const NO_HANDS = { can_record: false, can_edit: false, can_confirm: false, can_dispute: false, can_withdraw: false };

/** The club's record, as a GET reads it, and a write that moves it and then loses its reply. */
function club(first: BookingResultView) {
  let current = first;
  return {
    read: { path: RESULT_PATH, respond: () => current },
    lands: (next: BookingResultView, lose: () => unknown = () => refuse(504, { error: "gateway_timeout" })) => () => {
      current = next;
      return lose();
    },
  };
}

async function fillAndSubmit() {
  const dialog = await screen.findByRole("dialog", { name: RESULT_SHEET.title });
  const games: [number, number][] = [[11, 7], [9, 11], [11, 5], [11, 8]];
  games.forEach(([a, b], i) => {
    fireEvent.change(within(dialog).getByRole("textbox", { name: RESULT_SHEET.scoreFor(i + 1, RESULT_SHEET.sideA) }), { target: { value: String(a) } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: RESULT_SHEET.scoreFor(i + 1, RESULT_SHEET.sideB) }), { target: { value: String(b) } });
  });
  fireEvent.click(within(dialog).getByRole("button", { name: RESULT_SHEET.submit }));
  return dialog;
}

describe("record", () => {
  it("landed behind a 504: the card shows the result it recorded and says the reply was lost", async () => {
    const c = club(view());
    serve([c.read, { method: "POST", path: RESULT_PATH, respond: c.lands(submitterView()) }]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: RESULT_CARD.record }));
    await fillAndSubmit();
    expect(await screen.findByText(RESULT_LOST(RESULT_SHEET.recorded), { selector: "[data-result-notice] *, [data-result-notice]" })).toBeInTheDocument();
    await waitFor(() => expect(card().querySelector("[data-result-status]")).toHaveAttribute("data-result-status", "pending"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(card()).not.toHaveTextContent(/Couldn't/);
  });

  it("landed behind a dropped connection is believed too", async () => {
    const c = club(view());
    serve([c.read, { method: "POST", path: RESULT_PATH, respond: c.lands(submitterView(), () => { throw new TypeError("Failed to fetch"); }) }]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: RESULT_CARD.record }));
    await fillAndSubmit();
    await waitFor(() => expect(card().querySelector("[data-result-status]")).toHaveAttribute("data-result-status", "pending"));
    expect(card()).toHaveTextContent(RESULT_LOST(RESULT_SHEET.recorded));
  });

  it("someone else's result is not this press's: not landed, nothing changed", async () => {
    const theirs = view({ result: result({ submitted_by: { user_id: SAM, name: "Sam Petersen" } }), permissions: NO_HANDS });
    const c = club(view());
    serve([c.read, { method: "POST", path: RESULT_PATH, respond: c.lands(theirs) }]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: RESULT_CARD.record }));
    const dialog = await fillAndSubmit();
    expect(await within(dialog).findByText(RESULT_UNSURE.record.checked)).toBeInTheDocument();
  });

  it("a record that did not land, read back, says nothing changed", async () => {
    serve([{ path: RESULT_PATH, body: view() }, { method: "POST", path: RESULT_PATH, respond: () => refuse(504, { error: "gateway_timeout" }) }]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: RESULT_CARD.record }));
    const dialog = await fillAndSubmit();
    expect(await within(dialog).findByText(RESULT_UNSURE.record.checked)).toBeInTheDocument();
  });

  it("when the read-back fails too, it says it cannot tell", async () => {
    let reads = 0;
    serve([
      { path: RESULT_PATH, respond: () => { reads += 1; return reads === 1 ? view() : refuse(503, { error: "down" }); } },
      { method: "POST", path: RESULT_PATH, respond: () => refuse(504, { error: "gateway_timeout" }) },
    ]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: RESULT_CARD.record }));
    const dialog = await fillAndSubmit();
    expect(await within(dialog).findByText(RESULT_UNSURE.record.unchecked)).toBeInTheDocument();
  });
});

describe("confirm and dispute", () => {
  const confirmed = view({ result: result({ status: "confirmed", viewer_side: "b", viewer_outcome: "lost" }), permissions: NO_HANDS });

  it("the card's own Confirm: landed behind a 504 reads as confirmed", async () => {
    const c = club(samView());
    serve([c.read, { method: "POST", path: `${RESULT_PATH}/confirm`, respond: c.lands(confirmed) }]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: RESULT_CARD.confirm }));
    expect(await screen.findByText(RESULT_LOST(CONFIRM_SHEET.confirmed), { selector: "[data-result-notice]" })).toBeInTheDocument();
    await waitFor(() => expect(card().querySelector("[data-result-status]")).toHaveAttribute("data-result-status", "confirmed"));
    expect(card()).not.toHaveTextContent(/Couldn't/);
  });

  it("Something's wrong: a dispute that landed behind a 504 reads as sent", async () => {
    const me = "44444444-4444-4444-4444-444444444444";
    const disputed = view({ result: result({ status: "disputed", disputed_by: { user_id: me, name: "Nomsa" } }), permissions: NO_HANDS });
    const c = club(samView());
    serve([c.read, { method: "POST", path: `${RESULT_PATH}/dispute`, respond: c.lands(disputed) }]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: RESULT_CARD.somethingWrong }));
    const dialog = await screen.findByRole("dialog", { name: CONFIRM_SHEET.title });
    fireEvent.click(within(dialog).getByRole("button", { name: CONFIRM_SHEET.send }));
    expect(await screen.findByText(RESULT_LOST(CONFIRM_SHEET.disputed), { selector: "[data-result-notice]" })).toBeInTheDocument();
  });

  it("a confirm that did not land says the result still waits", async () => {
    serve([{ path: RESULT_PATH, body: samView() }, { method: "POST", path: `${RESULT_PATH}/confirm`, respond: () => refuse(502, { error: "bad_gateway" }) }]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: RESULT_CARD.confirm }));
    expect(await screen.findByText(RESULT_UNSURE.confirm.checked)).toBeInTheDocument();
  });
});

describe("edit and withdraw", () => {
  it("an edit that landed behind a 504 reads as saved", async () => {
    const edited = submitterView({ result: result({ version: 2, games: [{ a: 11, b: 7 }, { a: 9, b: 11 }, { a: 11, b: 5 }, { a: 11, b: 9 }] }) });
    const c = club(submitterView());
    serve([c.read, { method: "PUT", path: RESULT_PATH, respond: c.lands(edited) }]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: RESULT_CARD.edit }));
    const dialog = await screen.findByRole("dialog", { name: RESULT_SHEET.editTitle });
    fireEvent.change(within(dialog).getByRole("textbox", { name: RESULT_SHEET.scoreFor(4, RESULT_SHEET.sideB) }), { target: { value: "9" } });
    fireEvent.click(within(dialog).getByRole("button", { name: RESULT_SHEET.save }));
    expect(await screen.findByText(RESULT_LOST(RESULT_SHEET.saved), { selector: "[data-result-notice]" })).toBeInTheDocument();
  });

  it("a withdraw that landed behind a 504 reads as withdrawn", async () => {
    const gone = view({ result: result({ status: "withdrawn" }), permissions: { ...NO_HANDS, can_record: true } });
    const c = club(submitterView());
    serve([c.read, { method: "POST", path: `${RESULT_PATH}/withdraw`, respond: c.lands(gone) }]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: RESULT_CARD.withdraw }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: RESULT_CARD.withdraw }));
    expect(await screen.findByText(RESULT_LOST(RESULT_CARD.withdrawn), { selector: "[data-result-notice]" })).toBeInTheDocument();
    await waitFor(() => expect(card().querySelector("[data-result-status]")).toHaveAttribute("data-result-status", "withdrawn"));
  });

  it("a withdraw that did not land says the result is still there, beside the card", async () => {
    serve([{ path: RESULT_PATH, body: submitterView() }, { method: "POST", path: `${RESULT_PATH}/withdraw`, respond: () => refuse(504, { error: "gateway_timeout" }) }]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: RESULT_CARD.withdraw }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: RESULT_CARD.withdraw }));
    expect(await screen.findByText(RESULT_UNSURE.withdraw.checked, { selector: "[data-result-notice]" })).toBeInTheDocument();
  });
});
