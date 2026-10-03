import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { DETAIL_ACTIONS, DETAIL_COPY } from "@/lib/playersCopy";
import { showsResult } from "../detail/detailModel";
import { DETAIL_PATH, SAM_SEAT, detail, renderDetail, seat, serve } from "./detailKit";

/**
 * R7 E7-5 — a member who paid for somebody else's court at the box reads that booking: the club
 * answers `viewer.role: "payer"` with every permission false. The page is read-only for them, says
 * what they did, and never asks for a result that is the game's own players' (§3.4).
 */

afterEach(() => { vi.unstubAllGlobals(); signOut(); });

function payerView() {
  const d = detail({ players: [seat(), SAM_SEAT] });
  return { ...d, viewer: { role: "payer", participant_id: null }, permissions: Object.fromEntries(Object.keys(d.permissions).map((k) => [k, false])) } as unknown as typeof d;
}

describe("E7-5 — the payer at the box", () => {
  it("never shows (or asks for) the game's result", () => {
    expect(showsResult(payerView())).toBe(false);
  });

  it("reads the page: who paid is said in the header, and there is no action on it", async () => {
    const stub = serve({ detail: payerView() });
    renderDetail();
    expect(await screen.findByText(DETAIL_COPY.payerLine, { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: DETAIL_ACTIONS.removeFor("Sam") })).toBeNull();
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
    await waitFor(() => expect(stub.calls.some((c) => c.path.startsWith(`${DETAIL_PATH}/result`))).toBe(false));
  });
});
