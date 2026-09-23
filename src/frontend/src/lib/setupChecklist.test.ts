import { describe, expect, it } from "vitest";
import type { LedgerEntryType, WalletResponse } from "./api";
import { checklistProgress, deriveChecklist } from "./setupChecklist";

/**
 * P8 — what the checklist on My Code derives from real reads. The mutant that matters: a failed
 * read shown as "not done yet", which tells a member who did the thing that they have not.
 */

function wallet(balance: number, types: LedgerEntryType[] = []): WalletResponse {
  return {
    balance_credits: balance,
    entries: types.map((type, i) => ({
      id: String(i), at: "2026-09-01T10:00:00Z", from: "", to: "", amountCredits: 10, signedAmountCredits: 10,
      type, comment: "", subjectUserId: "u", subjectName: "U", actorUserId: "u", actorName: "U", relatedBookingId: null,
    })),
    total_entries: types.length,
    offset: 0,
    limit: 50,
  };
}

const PASSKEY = { id: "p", label: "iPhone", transports: null, created_at: "2026-09-01T10:00:00Z", last_used_at: null };

function stateOf(items: ReturnType<typeof deriveChecklist>) {
  return Object.fromEntries(items.map((item) => [item.id, item.state]));
}

describe("the setup checklist", () => {
  it("says nothing is done for a brand-new member", () => {
    const items = deriveChecklist({ passkeys: [], wallet: wallet(0), installed: false });
    expect(stateOf(items)).toEqual({ passkey: "todo", topup: "todo", booking: "todo", install: "todo" });
    expect(checklistProgress(items)).toEqual({ done: 0, total: 4, allDone: false });
  });

  it("reads each item from its own evidence", () => {
    const items = deriveChecklist({ passkeys: [PASSKEY], wallet: wallet(0, ["TopUp", "BookingCharge"]), installed: true });
    expect(checklistProgress(items).allDone).toBe(true);
  });

  it("counts credit on the balance as topped up, and a walk-up at the box as a booking", () => {
    const items = deriveChecklist({ passkeys: [], wallet: wallet(40, ["AdminAdjustment", "LightsPurchase"]), installed: false });
    expect(stateOf(items)).toMatchObject({ topup: "done", booking: "done" });
  });

  it("does not count a refund or a penalty as a booking", () => {
    const items = deriveChecklist({ passkeys: [], wallet: wallet(0, ["CancellationRefund", "NoShowPenalty"]), installed: false });
    expect(stateOf(items).booking).toBe("todo");
  });

  it("says it could not check, rather than 'not done', when a read failed", () => {
    const items = deriveChecklist({ passkeys: null, wallet: null, installed: false });
    expect(stateOf(items)).toEqual({ passkey: "unknown", topup: "unknown", booking: "unknown", install: "todo" });
    expect(checklistProgress(items).done).toBe(0);
  });

  it("counts only what is done", () => {
    const items = deriveChecklist({ passkeys: [PASSKEY], wallet: null, installed: false });
    expect(checklistProgress(items)).toEqual({ done: 1, total: 4, allDone: false });
  });
});
