import { describe, expect, it } from "vitest";
import {
  serverBody, serverDictionaryKeys, serverItemKeys, serverResponseKeys, serverShapes, serverShapesAt,
  serverTypeProperties, type ServerScope,
} from "../test/serverContract";
import { groupAddResponse } from "../test/groupFixtures";
import type { LedgerPage, LedgerTotals, Page } from "./adminPaging";
import * as F from "../test/adminResponseFixtures";

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

/* ─────────────────────────── every other admin reply the console reads (A4-2) ─────────────────────────── */

/*
 * Two strengths of pin, chosen by who owns the type.
 *
 * `exact` — the type lives in `lib/adminApi.ts` or `lib/memberDetailApi.ts`, whose declarations this
 * suite keeps equal to the server: a key the server adds or drops turns it red.
 *
 * `reads` — the type lives in `lib/api.ts`, `playApi.ts`, `playersApi.ts` or `notificationsApi.ts`:
 * every key the console DECLARES is one the server writes. A key the server sends and the console
 * never declared is harmless there; a declared key the server never sends is the "undefined of
 * undefined" defect, and that is what fails.
 *
 * `it.fails` marks a mismatch that is a real bug owned elsewhere (a screen reads a key the server never
 * sends). It asserts the relationship that SHOULD hold; when somebody fixes the bug the test passes,
 * `it.fails` turns red, and the marker comes off.
 */
const keysOf = (shape: string[]) => [...shape].sort();
const exact = (shape: string[], fixture: object) => expect(keysOf(shape)).toEqual(sorted(fixture));
const reads = (shape: string[], fixture: object) => expect(shape).toEqual(expect.arrayContaining(Object.keys(fixture)));
const only = (shapes: string[][]) => {
  expect(shapes).toHaveLength(1);
  return shapes[0];
};
const last = (shapes: string[][]) => shapes[shapes.length - 1];
const ok = (file: string, scope: ServerScope) => serverShapes(file, scope);
const at = (file: string, scope: ServerScope, anchor: string | RegExp) => serverShapesAt(file, scope, anchor);

describe("control board", () => {
  const READER = "Services/ControlBoardReader.cs";
  const FILE = "Endpoints/AdminControlBoardEndpoints.cs";

  it("the board answers ControlBoardReader.BuildAsync, key for key", () => {
    expect(serverBody(FILE, { route: 'app.MapGet("/api/v1/admin/control-board"' })).toContain("reader.BuildAsync(");
    exact(serverDictionaryKeys(READER, "BuildAsync"), F.controlBoardView());
    exact(only(at(READER, "BuildAsync", /\["realtime"\] = /)), F.controlBoardRealtime());
  });

  // R4 wave B: the tile's `door` is sent — null, because no door is mapped to a court (a gate
  // carries no court numbers; a door is never a court's evidence).
  it("every key a court tile reads is one the server writes", () => {
    exact(serverDictionaryKeys(READER, "Tile"), F.controlBoardCourt());
  });

  it("the court tile's blocks", () => {
    exact(only(ok(READER, "LightsBlock")), F.controlBoardLights());
    exact(only(ok(READER, "TurnedOnBy")), F.controlBoardTurnedOnBy());
    exact(only(ok(READER, "CurrentBlock")), F.controlBoardCurrent());
    exact(only(ok(READER, "NextBlock")), F.controlBoardNext());
    exact(only(ok(READER, "Person")), F.controlBoardPerson());
    exact(only(ok(READER, "DeviceBlock")), F.controlBoardDevice());
    exact(only(ok(READER, "OpenErrorsOf")), F.openErrorCounts());
    exact(only(ok(READER, "OtherBox")), F.controlBoardOtherBox());
    exact(only(ok(READER, "BoxBlock")), F.controlBoardBox());
  });

  it("both stream tickets", () => {
    exact(only(ok(FILE, "MintTicket")), F.streamTicket());
    exact(only(ok("Endpoints/AdminMonitoringEndpoints.cs", "MintTicket")), F.streamTicket());
  });
});

describe("monitoring", () => {
  const FILE = "Endpoints/AdminMonitoringEndpoints.cs";
  const VIEW = "Endpoints/MonitoringSummaryView.cs";

  it("the fault list, its counts and its rows", () => {
    exact(only(ok(FILE, "ListAsync")), F.deviceErrorPage());
    exact(only(ok(FILE, "Counts")), F.openErrorCounts());
    exact(only(ok(VIEW, "Of")), F.deviceErrorRow());
  });

  it("resolving one answers the row; resolving many answers counts and one result per id", () => {
    expect(serverBody(FILE, "ResolveAsync")).toContain("Results.Ok(MonitoringErrorRow.Of(");
    exact(only(ok(FILE, "ResolveBulkAsync")), F.bulkResult());
    for (const shape of ok(FILE, "ResolveOneAsync")) exact(shape, F.bulkItem());
  });

  it("the summary and its blocks", () => {
    exact(last(ok(VIEW, "BuildAsync")), F.monitoringSummary());
    exact(only(at(VIEW, "BuildAsync", "Select(p => ")), F.summaryByDevice());
    exact(only(at(VIEW, "BuildAsync", /\bopen = /)), F.openErrorCounts());
    exact(only(at(VIEW, "BuildAsync", "last_24h = ")), { opened: 0, resolved: 0 });
    exact(only(at(VIEW, "BuildAsync", /worst_offender = [^,]*?:\s*/)), { device_code: "", open: 0 });
  });
});

describe("the night trace", () => {
  const FILE = "Endpoints/AdminMemberTraceEndpoints.cs";

  it("the night and its blocks", () => {
    expect(serverBody(FILE, "HandleAsync")).toContain("Results.Ok(Body(");
    exact(only(ok(FILE, "Body")), F.traceView());
    exact(only(at(FILE, "Body", "member = ")), F.traceMember());
    exact(only(at(FILE, "Body", "retention = ")), F.traceRetention());
    exact(only(ok(FILE, "Summary")), F.traceSummary());
  });

  // R4 wave B: `approximate` (the "≈" and the rail's explanation), `device_code` (the burst key that
  // keeps two doors in one minute apart) and `outage_id` (the board's outage the event fell inside)
  // are sent on every event.
  it("every key the night reads off an event is one the server writes", () => {
    exact(only(ok(FILE, "Event")), F.traceEvent());
  });

  it("an event's actor, subject and court", () => {
    exact(only(at(FILE, "Event", "actor = ")), F.traceActor());
    exact(only(at(FILE, "Event", /subject = [^,]*?:\s*/)), F.traceSubject());
    exact(only(at(FILE, "Event", /court = [^,]*?:\s*/)), F.traceCourt());
  });
});

describe("the change record", () => {
  const FILE = "Endpoints/AdminChangeEndpoints.cs";

  it("the page (the club's and a schedule's) and each row", () => {
    expect(serverBody(FILE, "HandleAsync")).toContain("PageAsync(");
    expect(serverBody(FILE, "ForScheduleAsync")).toContain("PageAsync(");
    exact(only(ok(FILE, "PageAsync")), F.adminChangePage());
    exact(only(ok(FILE, "Project")), F.adminChangeRow());
    exact(only(at(FILE, "Project", "actor = ")), F.adminChangeActor());
    exact(only(at(FILE, "Project", /subject = [^,]*?:\s*/)), F.adminChangeSubject());
    exact(only(at(FILE, "Project", "Select(f => ")), F.adminChangeField());
  });
});

describe("member groups (the rest)", () => {
  const FILE = "Endpoints/MemberGroupEndpoints.cs";

  it("the list, and every group in it", () => {
    exact(only(ok(FILE, "ListAsync")), F.memberGroupsList());
    exact(only(ok(FILE, "Wire")), F.memberGroupWire());
    // P13 §3.8: the group's `pricing` block and its per-court prices are gone from the wire; the
    // package discount (`package_discount_bps`) is pinned in the group itself above.
    exact(only(at(FILE, "Wire", "caps = ")), F.memberGroupCaps());
    exact(only(at(FILE, "Wire", "Select(w => ")), { day: "", start: "", end: "" });
  });

  it("create and edit answer the id and the name only", () => {
    exact(only(ok(FILE, "CreateAsync")), F.memberGroupSaved());
    exact(last(ok(FILE, "PatchAsync")), F.memberGroupSaved());
  });

  // R4 wave B: "Added <when> by <added_by_name>", the photo (a link) and `cursor` are sent; the
  // cursor is always null — every member comes in one reply, so the paging loop ends at once.
  it("every key the group's member list is read for is one the server writes", () => {
    exact(only(ok(FILE, "MembersAsync")), F.memberGroupMembers());
    exact(only(at(FILE, "MembersAsync", "Select(r => ")), F.memberGroupMember());
  });

  it("the member list answers members, a total and a null cursor, each naming who added them", () => {
    exact(only(ok(FILE, "MembersAsync")), { members: [], total: 0, cursor: null });
    exact(
      only(at(FILE, "MembersAsync", "Select(r => ")),
      { user_id: "", name: "", photo_url: null, membership_number: "", added_at: "", added_by_name: null },
    );
  });

  it("the preview answers what applies now and what would", () => {
    exact(last(ok(FILE, "PreviewAsync")), F.memberGroupPreview());
    expect(serverBody(FILE, "RulesForMemberAsync")).toContain("ResolvedAsync(");
  });

  // BUG (not fixed here): GroupPreview.tsx reads `club_hours` and always says "The club's own hours
  // for that day were not sent." — Resolved() never writes it. `empty_window_reason` is read too but
  // falls back to the `empty_window_groups` the server does send, so that half is benign.
  it.fails("every key the member preview reads is one the server writes", () => {
    exact(only(ok(FILE, "Resolved")), F.memberBookingRules());
  });

  it("the rules' nested blocks and the tariff", () => {
    exact(only(at(FILE, "Resolved", "Select(g => ")), { id: "", name: "", description: "" });
    exact(only(at(FILE, "Resolved", "Select(w => ")), { start: "", end: "" });
    exact(only(ok(FILE, "TariffWire")), F.memberTariff());
  });

  it("setting one member's groups", () => {
    const SET = "Endpoints/AdminMemberGroupsEndpoint.cs";
    exact(last(ok(SET, "SetAsync")), F.memberGroupsSet());
    exact(only(at(SET, "SetAsync", "tariff = ")), F.memberTariff());
    exact(only(at("Endpoints/AdminMemberEndpoints.cs", "GroupsWire", "Select(g => ")), F.memberGroupChip());
  });
});

describe("minutes and the member's code", () => {
  it("an adjustment answers the movement, both balances and who was moved", () => {
    const FILE = "Endpoints/WalletEndpoints.cs";
    exact(only(ok(FILE, "AdjustmentResult")), F.adminAdjustResult());
    exact(only(at(FILE, "AdjustmentResult", "member = ")), F.adminAdjustResult().member!);
  });

  it("a code reset", () => {
    exact(last(ok("Endpoints/AdminMemberEndpoints.cs", "ResetCodeAsync")), F.memberCodeReset());
  });
});

describe("one member (memberDetailApi)", () => {
  const FILE = "Endpoints/AdminMemberDetailEndpoints.cs";

  it("the detail and its blocks", () => {
    exact(last(ok(FILE, "DetailAsync")), F.memberDetail());
    exact(only(at(FILE, "DetailAsync", "tariff = ")), F.memberTariff());
    exact(last(ok(FILE, "ReviewAsync")), F.memberReview());
    exact(serverTypeProperties(FILE, "FingerprintSummary"), F.memberFingerprints());
    exact(serverTypeProperties(FILE, "FingerprintEnrolment"), F.fingerprintEnrolment());
    exact(serverTypeProperties(FILE, "ActivityCounts"), F.memberCounts());
  });

  it("a booking row, as the detail and every bookings page carry it", () => {
    exact(serverTypeProperties(FILE, "MemberBookingRow"), F.memberBookingRow());
    exact(serverTypeProperties(FILE, "MemberBookingActor"), F.memberBookingActor());
    exact(last(ok(FILE, "BookingsAsync")), F.memberBookingsPage());
  });

  it("the member's door history", () => {
    const DOORS = "Endpoints/AdminMemberDoorEndpoints.cs";
    exact(last(ok(DOORS, "HandleAsync")), F.memberDoorsPage());
    exact(only(at(DOORS, "HandleAsync", "member = ")), F.memberDoorsPage().member);
    exact(only(ok(DOORS, "Item")), F.memberDoorRow());
    for (const shape of ok("Endpoints/DoorRowDoor.cs", "Of")) exact(shape, F.memberDoorRow().door);
  });

  it("granting or revoking admin rights", () => {
    exact(only(ok("Endpoints/AdminRoleEndpoints.cs", "Answer")), F.adminRoleResult());
  });
});

describe("bookings at the desk (lib/api.ts)", () => {
  const FILE = "Endpoints/BookingEndpoints.cs";
  const BULK = "Endpoints/AdminBulkBookingEndpoints.cs";

  it("book, cancel and block", () => {
    expect(serverBody(FILE, { route: 'admin.MapPost("/", async (AdminBookingRequest' })).toContain("ToHttpResult(");
    expect(serverBody(FILE, { route: 'blocks.MapPost("/"' })).toContain("ToHttpResult(");
    reads(ok(FILE, "ToHttpResult")[0], F.adminBookAnswer());
    reads(ok(FILE, "ToHttpResult")[0], F.adminBlockAnswer());
    reads(only(ok(FILE, "CancelledAnswer")), F.adminCancelAnswer());
  });

  it("the single and the batch quote", () => {
    reads(last(ok(FILE, "AdminQuoteAsync")), F.adminBookingQuote());
    reads(last(ok(BULK, "QuoteAsync")), F.adminBulkQuote());
    reads(only(at(BULK, "QuoteAsync", "Select((l, index) => ")), F.adminBulkQuoteItem());
  });

  it("bulk cancel and bulk book, and the row keys the sheets' flows read", () => {
    reads(last(ok(BULK, "CancelAsync")), F.bulkCancelResponse());
    // cancelFlow.ts fromBulk + splitCancelOf read these off each row.
    // The reply's own `results` projection — the change record's `bookings` rows (R5 A5-2) project too.
    reads(only(at(BULK, "CancelAsync", "results = outcome.Results.Select(r => ")),
      { booking_id: 0, status: 0, error: 0, refund_minutes: 0, penalty_minutes: 0, net_minutes: 0, partner_refunds: 0 });
    reads(last(ok(BULK, "BookAsync")), F.bulkBookResponse());
    reads(only(at(BULK, "BookAsync", /payer = [^;]*?:\s*/)), F.bulkBookPayer());
    // bookFlow.ts fromAdminBulk reads these off each row.
    reads(only(at(BULK, "BookAsync", "results = outcome.Results.Select(r => ")), { index: 0, status: 0, error: 0 });
  });
});

describe("members (lib/api.ts)", () => {
  const FILE = "Endpoints/AdminMemberEndpoints.cs";
  const route = (path: string) => ({ route: `g.MapPost("/{memberId:guid}/${path}"` });

  it("the lifecycle transitions and the password reset", () => {
    reads(only(ok(FILE, route("approve"))), F.approveAnswer());
    reads(only(ok(FILE, route("reject"))), F.rejectAnswer());
    reads(only(at(FILE, route("suspend"), "TransitionResult(r.Result, ")), F.suspendAnswer());
    reads(only(at(FILE, route("reactivate"), "TransitionResult(r.Result, ")), F.reactivateAnswer());
    reads(only(ok(FILE, route("reset-password"))), F.resetPasswordAnswer());
    reads(only(ok("Endpoints/PinEndpoints.cs", { route: 'app.MapPost("/api/v1/admin/members/{memberId:guid}/pin"' })), F.pinAnswer());
  });

  it("the spend drill-down", () => {
    const spend = { route: 'g.MapGet("/{memberId:guid}/spend"' };
    reads(last(ok(FILE, spend)), F.memberSpendReport());
    reads(only(at(FILE, spend, "member = ")), F.memberSpendMember());
    reads(only(at(FILE, spend, "totals = ")), F.memberSpendTotals());
    reads(only(at(FILE, spend, "Select(g2 => ")), F.memberSpendMonth());
  });
});

describe("webhooks, biometrics and reports (lib/api.ts)", () => {
  it("webhooks", () => {
    const FILE = "Endpoints/WebhookEndpoints.cs";
    expect(serverBody(FILE, { route: 'admin.MapGet("/",' })).toContain("Project(");
    expect(serverBody(FILE, { route: 'admin.MapPost("/",' })).toContain("Results.Ok(Project(");
    reads(only(ok(FILE, "Project")), F.webhookEndpoint());
    reads(only(at(FILE, { route: 'admin.MapGet("/{id:guid}/deliveries"' }, "Select(d => ")), F.webhookDelivery());
  });

  it("biometric enrolment", () => {
    const FILE = "Endpoints/BiometricEndpoints.cs";
    reads(only(ok(FILE, { route: 'admin.MapPost("/enroll"' })), F.biometricEnrollAnswer());
    const list = { route: 'admin.MapGet("/enrollments"' };
    reads(only(at(FILE, list, "Select(m => ")), F.biometricEnrollment());
    reads(at(FILE, list, "Select(t => ").find((s) => s.includes("template_id"))!, F.biometricTemplate());
  });

  it("the four admin reports", () => {
    const FILE = "Endpoints/ReportingEndpoints.cs";
    reads(only(ok(FILE, { route: 'admin.MapGet("/revenue"' })), F.revenueReport());
    const utilisation = ok(FILE, { route: 'admin.MapGet("/utilisation"' });
    reads(utilisation[0], F.utilisationRow());
    reads(last(utilisation), F.utilisationReport());
    reads(only(ok(FILE, { route: 'admin.MapGet("/no-shows"' })), F.noShowReport());
    reads(only(ok(FILE, { route: 'admin.MapGet("/daily"' })), F.dailyAdminPoint());
  });
});

describe("devices, courts and doors (lib/api.ts)", () => {
  const DEVICES = "Endpoints/AdminDeviceEndpoints.cs";

  it("every device read and write answers DeviceView.Of", () => {
    expect(serverBody(DEVICES, "ListAsync")).toContain("DeviceView.Of(");
    expect(serverBody(DEVICES, "UpdateAsync")).toContain("Results.Ok(DeviceView.Of(");
    reads(only(ok("Endpoints/DeviceView.cs", "Of")), F.adminDevice());
    reads(only(ok("Endpoints/DeviceView.cs", "Of")), { unchanged: false });
    reads(last(ok(DEVICES, "DeleteAsync")), F.deviceDeleteAnswer());
    reads(only(ok(DEVICES, "ApiKeyView")), F.deviceApiKey());
  });

  it("a board's own trail", () => {
    const FILE = "Endpoints/AdminDeviceActivityEndpoint.cs";
    reads(last(ok(FILE, "HandleAsync")), F.deviceActivityPage());
    expect(serverBody(FILE, "Item")).toContain("DoorActivityView.Of(");
    reads(only(ok("Endpoints/DoorActivityView.cs", "Of")), F.deviceActivityEntry());
    reads(only(ok("Endpoints/DoorActivityView.cs", "Member")), F.deviceActivityMember());
    reads(only(at(FILE, "Grouped", "events.Add(")), F.doorEventEntry());
  });

  // R4 wave B: the courts moved out of AdminConfigEndpoints into their own file, with their change record.
  it("courts", () => {
    const FILE = "Endpoints/AdminCourtEndpoints.cs";
    expect(serverBody(FILE, "MapAdminCourtEndpoints")).toContain('courts.MapDelete("/{id:guid}", DeactivateAsync)');
    // P13 §3.9: a court carries no price. Pinned without the retired `slice_price_credits`, which
    // `adminCourt()` keeps only while the deprecated type requires it (integrator's fixture).
    reads(only(at(FILE, "ListAsync", "Select(c => ")), { id: "", court_number: 0, name: "", court_type: "", is_active: false });
    reads(last(ok(FILE, "CreateAsync")), F.courtCreateAnswer());
    reads(last(ok(FILE, "UpdateAsync")), F.courtUpdateAnswer());
    reads(last(ok(FILE, "DeactivateAsync")), F.courtDeleteAnswer());
  });

  it("the doors overview, its rows and its signals", () => {
    const FILE = "Endpoints/AdminDoorsOverviewEndpoint.cs";
    reads(only(ok(FILE, "HandleAsync")), F.doorsView());
    reads(only(at(FILE, "HandleAsync", /shut_together = doors[^;]*?\.Select\(d => /)), F.doorName());
    reads(only(at(FILE, "HandleAsync", /shut_individually = doors[^;]*?\.Select\(d => /)), F.doorName());
    reads(only(at(FILE, "HandleAsync", /doors = doors\.Select\(d => /)), F.doorRow());
    reads(last(ok(FILE, "Today")), F.doorRow().today!);
    reads(only(ok("Services/DoorSignals.cs", "ToWire")), F.doorSignal());
  });

  // BUG (benign, not fixed here): AdminDoorDevice declares `shut_by_shut_all_at`, which
  // useDoorsChrome.ts reads as its second fallback for "shut together"; DeviceView.Of never writes it.
  // No screen is wrong today, because the overview always sends `shut_together`, the first answer.
  it.fails("every key a door row declares is one DeviceView writes", () => {
    reads(only(ok("Endpoints/DeviceView.cs", "Of")), F.adminDoorDevice());
  });

  it("the club door log", () => {
    const FILE = "Endpoints/AdminDoorLogEndpoint.cs";
    reads(last(ok(FILE, "HandleAsync")), F.doorLogPage());
    expect(serverBody(FILE, "HandleAsync")).toContain("DoorActivityView.WithDoor(");
    reads(only(ok("Endpoints/DoorActivityView.cs", "WithDoor")), F.doorLogEntry());
    for (const shape of ok("Endpoints/DoorRowDoor.cs", "Of")) reads(shape, F.doorLogDoor());
    reads(only(at(FILE, "RemovedDoorsAsync", "removed.Add(")), F.removedDoor());
  });

  it("shut all and reopen all", () => {
    const FILE = "Endpoints/AdminDoorFleetEndpoint.cs";
    reads(last(ok(FILE, "ApplyAsync")), F.fleetResult());
    reads(only(ok(FILE, "Wire")), F.fleetDoor());
    reads(only(at(FILE, "ApplyAsync", "Select(d => ")), F.doorName());
  });
});

describe("play (lib/playApi.ts)", () => {
  const QUERY = "Services/Play/PlayQuery.cs";

  it("the results list, each result, the count and a member's play", () => {
    reads(last(ok(QUERY, "AdminResultsAsync")), F.adminResultsPage());
    expect(serverBody(QUERY, "AdminResultAsync")).toContain("WithBookingsAsync(");
    expect(serverBody("Endpoints/AdminPlayEndpoints.cs", "AnswerAsync")).toContain("AdminResultAsync(");
    // The result's own keys plus the three WithBookingsAsync adds for an admin (no viewer).
    const keys = [...serverDictionaryKeys("Services/Play/ResultViews.cs", "Result"), ...serverDictionaryKeys(QUERY, "WithBookingsAsync", "view")];
    reads(keys, F.adminResult());
    reads(only(ok("Endpoints/AdminPlayEndpoints.cs", "CountAsync")), F.disputedCount());
    reads(last(ok(QUERY, "AdminMemberAsync")), F.adminMemberPlay());
  });
});

describe("players at the desk (lib/playersApi.ts)", () => {
  const ADMIN = "Services/Players/PlayersAdminService.cs";
  const SERVICE = "Services/Players/PlayersService.cs";

  it("add answers the organiser's own add", () => {
    expect(serverBody(ADMIN, "AddAsync")).toContain("return added;");
    reads(only(at(SERVICE, "AddSeatsAsync", "PlayerOutcome.Ok(")), F.addPlayersAnswer());
    reads(only(at(SERVICE, "AddSeatsAsync", "Select(a => ")), F.addedParticipant());
  });

  it("remove, accept, settle outside and collect", () => {
    reads(only(at(ADMIN, "WithReturnStateAsync", "PlayerOutcome.Ok(")), F.returnAnswer());
    // R18 J18-2: the seat answer is built once, by PlayersService.AlreadyThere (a won race and a twin
    // that found the seat already there answer alike).
    reads(only(at(SERVICE, "AlreadyThere", "PlayerOutcome.Ok(")), F.seatAnswer());
    reads(only(at(ADMIN, "CollectAsync", "PlayerOutcome.Ok(")), F.collectAnswer());
  });
});

describe("notifications (lib/notificationsApi.ts)", () => {
  const FILE = "Endpoints/AdminNotificationEndpoints.cs";

  it("the feed, each notice, and the kinds", () => {
    reads(last(ok(FILE, "FeedAsync")), F.adminNoticePage());
    reads(only(ok(FILE, "Project")), F.adminNotice());
    reads(only(at(FILE, "Project", "delivery = ")), F.adminNoticeDelivery());
    reads(last(ok(FILE, "KindsAsync")), F.adminNoticeKinds());
    reads(only(ok(FILE, "KindView")), F.adminNoticeKind());
  });
});

describe("paged admin reads (R4 carry-over: Transactions totals over the whole range)", () => {
  it("the ledger's page is { items, next_cursor, totals }, totals as the page reads them", () => {
    const page: Required<LedgerPage> = { items: [], next_cursor: null, total: 0, totals: { count: 0, in_minutes: 0, out_minutes: 0, net_minutes: 0 } };
    const { total: _total, ...ledger } = page;
    void _total;
    // serverShapes: this handler's comments carry commas, which the older reader counts as keys.
    expect(serverShapes("Endpoints/AdminLedgerEndpoints.cs", "ListAsync").at(-1)?.sort()).toEqual(sorted(ledger));
    const totals: Required<LedgerTotals> = { count: 0, in_minutes: 0, out_minutes: 0, net_minutes: 0 };
    expect(server("Endpoints/AdminLedgerEndpoints.cs", "TotalsAsync")).toEqual([sorted(totals)]);
  });

  it("the members' page is { items, next_cursor, total }", () => {
    const page: Required<Page<unknown>> = { items: [], next_cursor: null, total: 0 };
    expect(server("Endpoints/AdminMemberEndpoints.cs", "ListAsync").at(-1)).toEqual(sorted(page));
  });
});
