import { describe, expect, it } from "vitest";
import { serverEnumMembers } from "../test/serverContract";
import { ADMIN_LEDGER_TYPES, LEDGER_TYPE_LABEL, ledgerTypeLabel } from "./creditAdjustment";

/**
 * Review round 2, F3-5: desk top-ups read "AdminTopUp" on the Transactions page and the Type
 * filter could not select them — the admin's list of ledger types was the frontend's own and had
 * never met `AdminTopUp`. It is compared here with the C# enum itself.
 */
describe("the admin's ledger types are the server's", () => {
  const server = serverEnumMembers("Domain/LedgerEntry.cs", "LedgerEntryType");

  it("lists every type the backend can write, and no other", () => {
    expect(server).toContain("AdminTopUp");
    expect([...ADMIN_LEDGER_TYPES].sort()).toEqual([...server].sort());
  });

  it("names every one of them in words", () => {
    expect(Object.keys(LEDGER_TYPE_LABEL).sort()).toEqual([...server].sort());
    for (const type of server) expect(ledgerTypeLabel(type)).not.toBe(type);
    expect(ledgerTypeLabel("AdminTopUp")).toBe("Desk top-up");
  });
});
