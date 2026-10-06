import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { ApiError, NetworkError } from "./api";
import { writeOrReadBack } from "./lostReply";
import { LOST_REPLY } from "./lostReplyCopy";
import { INVITE_UNSURE } from "./playersCopy";
import { BOOK_SHEET } from "./bookingsCopy";
import { cancellationOutcome } from "./bookingErrors";
import { ADD_LOST } from "./groupsCopy";
import { CANCEL_SAID, cancelFailedSentence, cancelledSentence } from "./topUpOpen";
import { UnsureOutcome } from "./bookingOutcome";
import { refuse, renderPage, signOut, stubFetch, type StubRoute } from "@/test/harness";
import AdminWebhooksPage from "@/pages/AdminWebhooks";

/**
 * R19 (integrator, after X19-2) — a write the club's system answered with an ERROR (a plain 500),
 * read back and found to have LANDED, said "Done. The club's reply didn't arrive, so we checked its
 * record." The reply did arrive — it was an error. Proven-after-an-answer now says what the answer
 * was and that the record shows it went through; a reply that really did not arrive (502/504, a
 * dropped connection) keeps its words.
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

const DIDNT_ARRIVE = /reply didn't arrive/;

describe("the proven sentence, by what answered (R19)", () => {
  it("writeOrReadBack carries why the outcome was unsure: a 500 is an error, a 504 silence, a busy 503 busy", async () => {
    const after = (e: unknown) => writeOrReadBack(() => Promise.reject(e), async () => ({ ok: true }));
    expect((await after(new ApiError(500, {}))).answered).toBe("error");
    expect((await after(new ApiError(504, {}))).answered).toBe("silent");
    expect((await after(new NetworkError("unreachable"))).answered).toBe("silent");
    expect((await after(new ApiError(503, { error: "service_busy" }))).answered).toBe("busy");
    expect((await after(new ApiError(503, { error: "conflict_retry" }))).answered).toBe("conflict");
    expect((await writeOrReadBack(async () => ({ ok: true }), async () => null)).answered).toBeUndefined();
  });

  it("each reason says what answered and that the record shows it went through", () => {
    expect(LOST_REPLY.proven("Done.")).toBe("Done. The club's reply didn't arrive, so we checked its record.");
    expect(LOST_REPLY.proven("Done.", "silent")).toBe(LOST_REPLY.proven("Done."));
    for (const why of ["error", "busy", "conflict"] as const) {
      const said = LOST_REPLY.proven("Done.", why);
      expect(said).toMatch(/^Done\. /);
      expect(said).toMatch(/but we checked its record: it went through\.$/);
      expect(said).not.toMatch(DIDNT_ARRIVE);
    }
    expect(LOST_REPLY.proven("Done.", "error")).toMatch(/hit an error/);
    expect(LOST_REPLY.proven("Done.", "busy")).toMatch(/too busy/);
  });

  it("the accept and the decline: their notes by reason too", () => {
    expect(INVITE_UNSURE.provenNoteAfter("error")).toMatch(/hit an error/);
    expect(INVITE_UNSURE.provenNoteAfter("error")).not.toMatch(DIDNT_ARRIVE);
    expect(INVITE_UNSURE.provenNoteAfter("silent")).toBe(INVITE_UNSURE.provenNote);
    expect(INVITE_UNSURE.declineProvenNoteAfter("busy")).toMatch(/too busy/);
    expect(INVITE_UNSURE.declineProvenNoteAfter(undefined)).toBe(INVITE_UNSURE.declineProvenNote);
  });
});

describe("the other proven notes, and the purchase cancel's read-back, by reason (R19)", () => {
  it("booking read off the schedule, a cancel with its figures lost, a group add: an error is not 'didn't arrive'", () => {
    for (const said of [BOOK_SHEET.provenNoteAfter("error"), cancellationOutcome(null, null, null, null, "error"), ADD_LOST.provenAfter("error")]) {
      expect(said).toMatch(/hit an error/);
      expect(said).not.toMatch(DIDNT_ARRIVE);
    }
    expect(BOOK_SHEET.provenNoteAfter("silent")).toBe(BOOK_SHEET.provenNote);
    expect(cancellationOutcome(null, null)).toMatch(DIDNT_ARRIVE);
    expect(ADD_LOST.provenAfter(undefined)).toBe(ADD_LOST.proven);
  });

  it("a purchase cancel: landed after an error, and still waiting after an error or a busy club", () => {
    const status = { status: "Cancelled", minutes: 0 } as never;
    expect(cancelledSentence({ status, proven: true, answered: "error" })).toMatch(/hit an error, but the club's record was checked: the purchase is cancelled/);
    expect(cancelledSentence({ status, proven: true, answered: "silent" })).toBe(CANCEL_SAID.lostLanded);
    expect(cancelFailedSentence(new UnsureOutcome(new ApiError(500, {}), true))).toBe(CANCEL_SAID.errorStillWaiting);
    expect(cancelFailedSentence(new UnsureOutcome(new ApiError(503, { error: "service_busy" }), false))).toBe(CANCEL_SAID.busyUnknown);
    expect(cancelFailedSentence(new UnsureOutcome(new ApiError(504, {}), true))).toBe(CANCEL_SAID.lostStillWaiting);
  });
});

describe("a caller (webhook removal): a 500 that landed is not 'didn't arrive'", () => {
  const LIST = "/api/v1/admin/webhooks";
  const ROW = {
    id: "w1", url_template: "https://scoreboard.example.com/court/{court_number}/lit", event_filter: "booking.lights_on",
    description: "Scoreboard", enabled: true, failure_count: 0, last_success_at: null, last_failure_at: null,
    created_at: "2026-09-01T08:00:00Z", secret: null,
  };

  for (const [status, words] of [[500, /^Endpoint removed\. The club's system hit an error, but we checked its record: it went through\.$/], [504, /^Endpoint removed\. The club's reply didn't arrive, so we checked its record\.$/]] as const) {
    it(`${status}, the list no longer has it`, async () => {
      let rows: unknown[] = [ROW];
      const routes: StubRoute[] = [
        { path: LIST, respond: () => rows },
        { method: "DELETE", path: `${LIST}/w1`, respond: () => { rows = []; return refuse(status, {}); } },
      ];
      stubFetch(routes);
      renderPage(<AdminWebhooksPage />);
      fireEvent.pointerDown(await screen.findByRole("button", { name: "More actions for Scoreboard" }, { timeout: 10_000 }), { button: 0, ctrlKey: false, pointerType: "mouse" });
      fireEvent.click(await screen.findByRole("menuitem", { name: "Delete endpoint" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete endpoint" }));
      expect(await screen.findByText(words, {}, { timeout: 10_000 })).toBeInTheDocument();
    });
  }
});
