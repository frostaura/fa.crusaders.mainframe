import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { DETAIL_ADMIN, DETAIL_MONEY } from "@/lib/playersCopy";
import { ALEX_SEAT, SAM_SEAT, detail, renderDetail, seat, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * R17 E17-2 / E17-3 / L17-8 (client follow-through) — a cancelled game's row for a partner who paid
 * nothing said "Nothing owed · any share paid went back" — nothing had gone back to them. A share
 * the club recorded as paid by hand says so. And the club's seat menu says "paid by hand", never
 * "Settled outside the app".
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.unstubAllGlobals(); });

const cancelled = (players: ReturnType<typeof seat>[]) => detail({ status: "cancelled", players });

describe("a cancelled game's money rows say what is true of each seat (R17 E17-2)", () => {
  it("paid nothing: never 'went back'", async () => {
    serve({ detail: cancelled([seat(), { ...ALEX_SEAT, status: "accepted", paid_minutes: 0, unpaid_minutes: 0 }]) });
    renderDetail();
    const money = await screen.findByRole("region", { name: DETAIL_MONEY.title });
    const alex = within(money).getByText("Alex").closest("li")!;
    expect(alex).not.toHaveTextContent(/went back/);
    expect(alex).toHaveTextContent(/Paid nothing/);
  });

  it("paid by hand, nothing in the app: says paid by hand", async () => {
    serve({ detail: cancelled([seat(), { ...SAM_SEAT, settled_outside: true, paid_minutes: 0, returned_minutes: 0 }]) });
    renderDetail();
    const money = await screen.findByRole("region", { name: DETAIL_MONEY.title });
    expect(within(money).getByText("Sam").closest("li")!).toHaveTextContent(/paid .* by hand/i);
  });

  it("the club's seat menu word is 'paid by hand'", () => {
    expect(DETAIL_ADMIN.settle).toMatch(/paid by hand/i);
    expect(DETAIL_ADMIN.settle).not.toMatch(/outside/i);
  });
});
