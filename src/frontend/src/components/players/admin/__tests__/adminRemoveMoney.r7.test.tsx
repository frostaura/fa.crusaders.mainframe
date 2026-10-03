import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { DETAIL_ADMIN } from "@/lib/playersCopy";
import { ALEX_SEAT, adminView, renderDetail, seat, serve } from "../../__tests__/detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * R7 J7-9 — the club's Remove names the money before it is pressed: what goes back to the player,
 * from whose balance, and how much the organiser's cost for the court rises.
 */
beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

async function openRemove() {
  renderDetail();
  const trigger = await screen.findByRole("button", { name: DETAIL_ADMIN.menu("Alex") });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: DETAIL_ADMIN.remove }));
  return screen.findByRole("dialog");
}

function withAlex(paid: number, share: number) {
  return adminView({
    players: [
      seat({ user_id: "55555555-5555-5555-5555-555555555555", name: "Sam Petersen" }),
      seat({ ...ALEX_SEAT, seat: 2, team: "A", status: "accepted", consented_minutes: share, target_minutes: share, share_minutes: share, paid_minutes: paid, unpaid_minutes: share - paid }),
    ],
  });
}

describe("J7-9 — the remove confirm names the refund and the organiser's new cost", () => {
  it("a paid partner: their minutes go back from Sam's balance, and Sam's cost rises by the share", async () => {
    serve({ admin: true, detail: withAlex(30, 30) });
    const dialog = await openRemove();
    const said = DETAIL_ADMIN.removeBodyFor({ paid: 30, share: 30, organiser: "Sam" });
    expect(said).toMatch(/30 minutes/);
    expect(dialog).toHaveTextContent(said);
    expect(dialog).not.toHaveTextContent(DETAIL_ADMIN.removeBody);
  });

  it("an unpaid partner: nothing goes back, and Sam's cost still rises", async () => {
    serve({ admin: true, detail: withAlex(0, 25) });
    const dialog = await openRemove();
    expect(dialog).toHaveTextContent(DETAIL_ADMIN.removeBodyFor({ paid: 0, share: 25, organiser: "Sam" }));
  });
});
