import { describe, expect, it } from "vitest";
import { serverResponseKeys } from "../test/serverContract";
import {
  fullScheduleRowFixture, previewFixture, scheduleCreateResponse, scheduleDetailResponse,
  scheduleEndResponse, scheduleOccurrenceResponse, scheduleOccurrencesResponse, scheduleUpdateResponse,
} from "../test/scheduleFixtures";

/**
 * The schedule routes' RESPONSE shapes, pinned against the C# handlers (review round 2, F3-1).
 *
 * <p>
 * Round 1 pinned what the screen SENDS; nothing pinned what it READS, and the detail page read
 * `{ schedule, timezone }` as if it were the row: "Holds no courts yet on no days", "End
 * undefined", and a create notice reading "“undefined” was created". Both page suites were green
 * because each stubbed the reply with the frontend's own guess. The page tests now stub with
 * these envelope builders, and this file keeps every builder key-for-key equal to what the
 * server writes — a renamed or added wire key turns this red before it reaches a screen.
 * </p>
 */
const FILE = "Endpoints/AdminScheduleEndpoints.cs";
const sorted = (o: object) => Object.keys(o).sort();
const server = (method: string) => serverResponseKeys(FILE, method).map((keys) => [...keys].sort());

describe("schedule responses match the server's own construction", () => {
  it.each([
    ["GetAsync", scheduleDetailResponse()],
    ["OccurrencesAsync", scheduleOccurrencesResponse([])],
    ["CreateAsync", scheduleCreateResponse()],
    ["UpdateAsync", scheduleUpdateResponse()],
    ["OccurrenceAsync", scheduleOccurrenceResponse("2026-10-13")],
    ["EndAsync", scheduleEndResponse()],
    ["ProjectPreview", { ...previewFixture(), max_rows: 500 }],
  ])("%s", (method, fixture) => {
    expect(server(method)).toEqual([sorted(fixture)]);
  });

  it("the row inside every envelope carries exactly what Project writes", () => {
    expect(server("Project")).toEqual([sorted(fullScheduleRowFixture())]);
  });

  it("reads the list's envelope too — the page reads `.schedules` from it", () => {
    expect(server("ListAsync")).toEqual([["schedules", "timezone"]]);
  });
});
