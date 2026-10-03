import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { signOut } from "@/test/harness";
import { DETAIL_MONEY } from "@/lib/playersCopy";
import { minutesSpoken } from "@/lib/minutes";
import { detail, renderDetail, seat, serve } from "./detailKit";

vi.mock("@/components/players/PlayerPicker", () => ({ PlayerPicker: () => null, PlayerPickerDialog: () => null }));

/**
 * R8 E8-2 — the money panel of a court somebody paid for at the box. It said "This court isn't
 * split — the organiser covers it all." above "Ava's cost 0 min" (the organiser covered nothing in
 * the end), and to the member who paid at the box it said "Ben Payer paid for this court at the
 * court box, so Ava was refunded 30 minutes" — about himself, in the third person.
 */

beforeEach(() => { signOut(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const money = () => document.querySelector<HTMLElement>("[data-money-panel]") as HTMLElement;

function paidAtBox(role: "payer" | "organiser") {
  const d = detail({
    players: [seat({ name: "Ava Organiser" })],
    money: {
      price_minutes: 30, organiser_owed_minutes: 0, shares_received_minutes: 0, organiser_net_minutes: 0,
      unpaid_minutes: 0, share_deadline: "2026-10-02T18:45:00Z", is_split: false,
      paid_by: { user_id: "u-ben", name: "Ben Payer", photo_url: null }, paid_by_minutes: 30,
    },
  });
  if (role === "organiser") return d;
  return {
    ...d, viewer: { role: "payer", participant_id: null },
    permissions: Object.fromEntries(Object.keys(d.permissions).map((k) => [k, false])),
  } as unknown as typeof d;
}

describe("E8-2 — paid at the box", () => {
  it("never says the court isn't split and the organiser covers it all", async () => {
    serve({ detail: paidAtBox("organiser") });
    renderDetail();
    await screen.findByText(DETAIL_MONEY.paidAtBoxNote("Ben Payer", null, minutesSpoken(30)));
    expect(money()).not.toHaveTextContent(DETAIL_MONEY.notSplit);
  });

  it("tells the member who paid at the box about it in the second person, never by their own name", async () => {
    serve({ detail: paidAtBox("payer") });
    renderDetail();
    // The page's header says it too (DETAIL_COPY.payerLine); the money panel's own note must.
    const lines = await screen.findAllByText(/^You paid for this court at the/);
    expect(lines.some((line) => line.closest("[data-money-panel]") !== null)).toBe(true);
    expect(money()).not.toHaveTextContent("Ben Payer");
    expect(money()).not.toHaveTextContent(DETAIL_MONEY.notSplit);
  });
});
