import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { SellPackageSheet } from "../SellPackageSheet";
import { renderPage, stubFetch } from "@/test/harness";
import { seededShelf, shelfPackage } from "@/test/minutesFixtures";

/**
 * Review round 6, J6-4 — the desk sells off the member's shelf in the order the member's own Buy
 * page shows it: their groups' packages first, under each group, then the club's (`shelfSections`,
 * Dean's answer 2). The sheet listed the server's flat order, club packages first.
 */
afterEach(() => vi.unstubAllGlobals());

const USER = "44444444-4444-4444-4444-444444444444";

describe("J6-4 — the desk's Sell sheet", () => {
  it("lists the member's group packages first, as their Buy page does", async () => {
    const group = shelfPackage({ id: "g-night", name: "League night", minutes: 90, price_zar: 150, source: "group", group: { id: "g-league", name: "League" } });
    stubFetch([{ path: `/api/v1/admin/minutes/${USER}/packages`, body: { discount: null, packages: [...seededShelf(), group] } }]);
    renderPage(<SellPackageSheet userId={USER} name="Thandi" balance={120} onClose={() => {}} onSold={() => {}} />);
    const radios = await screen.findAllByRole("radio");
    expect(radios[0]).toHaveTextContent("League night");
    expect(radios).toHaveLength(seededShelf().length + 1);
  });
});
