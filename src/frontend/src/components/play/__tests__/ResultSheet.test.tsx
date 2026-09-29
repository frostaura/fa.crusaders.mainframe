import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { renderPage, signOut } from "@/test/harness";
import { ResultSheet } from "@/components/play/ResultSheet";
import type { BookingResultView, MatchResult } from "@/lib/playApi";
import { GAME_REASON, RESULT_SHEET } from "@/lib/playCopy";
import { NOMSA, RESULT_PATH, SAM_P, result, serve, view } from "./playKit";

/**
 * The result sheet's live validation (§9.2): the same PAR-11 rules as the server, said under
 * the row as it is typed; the running score in the header; rows that grow as games finish and
 * go once the match is decided; and a submit that says why it cannot be pressed yet.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

function Harness({ initial, editing, onDone }: { initial: BookingResultView; editing?: MatchResult; onDone: (r: MatchResult) => void }) {
  const [open, setOpen] = useState(true);
  return <ResultSheet open={open} onOpenChange={setOpen} view={initial} editing={editing} onDone={(r) => { onDone(r); setOpen(false); }} onStale={() => undefined} />;
}

async function openSheet(initial = view(), editing?: MatchResult) {
  const onDone = vi.fn();
  renderPage(<Harness initial={initial} editing={editing} onDone={onDone} />);
  const dialog = await screen.findByRole("dialog", { name: editing ? RESULT_SHEET.editTitle : RESULT_SHEET.title });
  return { dialog, onDone };
}

const box = (dialog: HTMLElement, game: number, side: "A" | "B") =>
  within(dialog).getByRole("textbox", { name: RESULT_SHEET.scoreFor(game, side === "A" ? RESULT_SHEET.sideA : RESULT_SHEET.sideB) });

function score(dialog: HTMLElement, game: number, a: number, b: number) {
  fireEvent.change(box(dialog, game, "A"), { target: { value: String(a) } });
  fireEvent.change(box(dialog, game, "B"), { target: { value: String(b) } });
}

const submit = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: RESULT_SHEET.submit });
const progress = () => document.querySelector("[data-match-progress]");
const rows = (dialog: HTMLElement) => dialog.querySelectorAll("[data-game-row]");

describe("live validation", () => {
  it("says each rule under the row as it is typed", async () => {
    serve();
    const { dialog } = await openSheet();
    score(dialog, 1, 12, 11);
    expect(within(dialog).getByText(GAME_REASON.not_two_clear)).toBeInTheDocument();
    expect(box(dialog, 1, "A")).toHaveAttribute("aria-invalid", "true");
    score(dialog, 1, 13, 10);
    expect(within(dialog).getByText(GAME_REASON.overrun)).toBeInTheDocument();
    score(dialog, 1, 11, 11);
    expect(within(dialog).getByText(GAME_REASON.tied)).toBeInTheDocument();
    score(dialog, 1, 10, 8);
    expect(within(dialog).getByText(GAME_REASON.below_eleven)).toBeInTheDocument();
    score(dialog, 1, 15, 13);
    expect(dialog.querySelector('[data-game-error="0"]')).toHaveTextContent("");
    expect(box(dialog, 1, "A")).not.toHaveAttribute("aria-invalid");
  });

  it("adds a row as a game finishes, keeps the running score, and drops rows once the match is won", async () => {
    serve();
    const { dialog } = await openSheet();
    expect(rows(dialog)).toHaveLength(1);
    expect(progress()).toHaveTextContent("0–0 · at least 3 more games");
    score(dialog, 1, 11, 7);
    expect(rows(dialog)).toHaveLength(2);
    score(dialog, 2, 9, 11);
    score(dialog, 3, 11, 5);
    expect(progress()).toHaveTextContent("2–1 · one more game");
    expect(rows(dialog)).toHaveLength(4);
    // Switching to best of 3 decides the match at 2–1: the fourth row goes.
    fireEvent.click(within(dialog).getByRole("radio", { name: "Best of 3" }));
    expect(rows(dialog)).toHaveLength(3);
    expect(progress()).toHaveTextContent("2–1 · match complete");
  });

  it("keeps the submit unpressable, with the reason beside it, until the match is complete", async () => {
    serve();
    const { dialog } = await openSheet();
    expect(submit(dialog)).toBeDisabled();
    const reason = dialog.querySelector("[data-submit-reason]");
    expect(reason).toHaveTextContent(RESULT_SHEET.needGames);
    expect(submit(dialog)).toHaveAttribute("aria-describedby", reason?.id);
    score(dialog, 1, 11, 10);
    expect(dialog.querySelector("[data-submit-reason]")).toHaveTextContent(RESULT_SHEET.fixGame(1));
    score(dialog, 1, 11, 9);
    score(dialog, 2, 11, 9);
    score(dialog, 3, 11, 9);
    expect(submit(dialog)).not.toBeDisabled();
    expect(dialog.querySelector("[data-submit-reason]")).toBeNull();
  });

  it("the steppers move a score a point at a time, never below zero", async () => {
    serve();
    const { dialog } = await openSheet();
    const more = within(dialog).getByRole("button", { name: `${RESULT_SHEET.scoreFor(1, RESULT_SHEET.sideA)}: one more` });
    fireEvent.click(more);
    fireEvent.click(more);
    expect(box(dialog, 1, "A")).toHaveValue("2");
    const fewer = within(dialog).getByRole("button", { name: `${RESULT_SHEET.scoreFor(1, RESULT_SHEET.sideA)}: one fewer` });
    fireEvent.click(fewer);
    fireEvent.click(fewer);
    expect(box(dialog, 1, "A")).toHaveValue("0");
  });
});

describe("the lineup", () => {
  it("is pre-filled from the server's default sides, and swaps players and scores together", async () => {
    serve();
    const { dialog } = await openSheet();
    const me = dialog.querySelector(`[data-candidate="${NOMSA.player_key}"]`) as HTMLElement;
    expect(within(me).getByRole("radio", { name: RESULT_SHEET.sideA })).toHaveAttribute("data-state", "on");
    score(dialog, 1, 11, 4);
    fireEvent.click(within(dialog).getByRole("button", { name: RESULT_SHEET.swap }));
    expect(within(me).getByRole("radio", { name: RESULT_SHEET.sideB })).toHaveAttribute("data-state", "on");
    expect(box(dialog, 1, "A")).toHaveValue("4");
    expect(box(dialog, 1, "B")).toHaveValue("11");
  });

  it("refuses uneven sides and a lineup without the submitter, in words", async () => {
    serve();
    const { dialog } = await openSheet();
    const sam = dialog.querySelector(`[data-candidate="${SAM_P.player_key}"]`) as HTMLElement;
    fireEvent.click(within(sam).getByRole("radio", { name: RESULT_SHEET.sideA }));
    expect(dialog.querySelector("[data-submit-reason]")).toHaveTextContent(RESULT_SHEET.needLineup);
    const me = dialog.querySelector(`[data-candidate="${NOMSA.player_key}"]`) as HTMLElement;
    fireEvent.click(within(me).getByRole("radio", { name: RESULT_SHEET.notPlaying }));
    fireEvent.click(within(sam).getByRole("radio", { name: RESULT_SHEET.sideB }));
    // Sam alone on B and nobody on A: uneven again.
    expect(dialog.querySelector("[data-submit-reason]")).toHaveTextContent(RESULT_SHEET.needLineup);
  });
});

describe("sending", () => {
  it("records with a fresh idempotency key, the lineup and the games", async () => {
    const stub = serve([{ method: "POST", path: RESULT_PATH, body: result() }]);
    const { dialog, onDone } = await openSheet();
    score(dialog, 1, 11, 7);
    score(dialog, 2, 9, 11);
    score(dialog, 3, 11, 5);
    score(dialog, 4, 11, 8);
    fireEvent.click(submit(dialog));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const post = stub.calls.find((c) => c.method === "POST" && c.path === RESULT_PATH);
    const body = post?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      format: "best_of_5",
      sideA: [NOMSA.player_key],
      sideB: [SAM_P.player_key],
      games: [{ a: 11, b: 7 }, { a: 9, b: 11 }, { a: 11, b: 5 }, { a: 11, b: 8 }],
    });
    expect(typeof body.idempotencyKey).toBe("string");
    expect((body.idempotencyKey as string).length).toBeGreaterThan(0);
    expect((body.idempotencyKey as string).length).toBeLessThanOrEqual(64);
  });

  it("edits a pending result with the version it was shown", async () => {
    const stub = serve([{ method: "PUT", path: RESULT_PATH, body: result({ version: 2 }) }]);
    const pending = result();
    const { dialog, onDone } = await openSheet(view({ result: pending }), pending);
    expect(box(dialog, 4, "B")).toHaveValue("8");
    score(dialog, 4, 11, 9);
    fireEvent.click(within(dialog).getByRole("button", { name: RESULT_SHEET.save }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const put = stub.calls.find((c) => c.method === "PUT" && c.path === RESULT_PATH);
    expect(put?.body).toMatchObject({ expectedVersion: 1, games: [{ a: 11, b: 7 }, { a: 9, b: 11 }, { a: 11, b: 5 }, { a: 11, b: 9 }] });
    expect(put?.body).not.toHaveProperty("idempotencyKey");
  });
});
