import { describe, expect, it } from "vitest";
import { serverItemKeys, serverResponseKeys } from "../test/serverContract";
import { groupAddResponse } from "../test/groupFixtures";

/**
 * Admin RESPONSE shapes the console reads, pinned against the C# handlers (review round 4, A4-2).
 *
 * <p>
 * The group add answered `{ results: [{ user_id, result }] }` while the screen's type said
 * `{ requested, succeeded, failed, results: [{ id, status }] }`: "undefined of undefined done"
 * and "refused… did not say why" beside a green tick, over people who had been added. Both
 * suites were green because the page test stubbed the reply with the frontend's own guess. Each
 * fixture here is the one the page tests stub with, compared key for key with the server.
 * </p>
 */
const sorted = (o: object) => Object.keys(o).sort();
const server = (file: string, method: string) => serverResponseKeys(file, method).map((k) => [...k].sort());
const items = (file: string, method: string, anchor: string) =>
  serverItemKeys(file, method, anchor).map((k) => [...k].sort());

describe("member groups", () => {
  const FILE = "Endpoints/MemberGroupEndpoints.cs";

  it("add members answers rows only, each { user_id, result }", () => {
    const fixture = groupAddResponse([{ user_id: "u1", result: "added" }]);
    // The last shape is the success; the first is the 400 too_many_members refusal.
    expect(server(FILE, "AddMembersAsync").at(-1)).toEqual(sorted(fixture));
    for (const shape of items(FILE, "AddMembersAsync", "results.Add(")) {
      expect(shape).toEqual(sorted(fixture.results[0]));
    }
  });
});
