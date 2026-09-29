import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ledgerRowFixture, signOut, unreachable } from "@/test/harness";
import { ACCESS_COPY, BOOKINGS_TAB_COPY, DOORS_TAB_COPY, LEDGER_LIMIT, WALLET_TAB_COPY } from "@/lib/memberDetailCopy";
import { DETAIL_LINKS } from "@/lib/playersCopy";
import { BASE, MEMBER_ID, baseRoutes, bookingRow, detailFixture, doorRow, doorsPage, renderMember, serve } from "./memberKit";

const at = (path: string) => `/admin/members/${MEMBER_ID}/${path}`;

describe("member detail — bookings tab", () => {
  beforeEach(() => { signOut(); });

  it("reads upcoming first and appends the next page on Load more, by cursor", async () => {
    const stub = serve(baseRoutes(detailFixture(), [
      {
        path: `${BASE}/bookings`,
        respond: ({ path }) => (path.includes("cursor=")
          ? { when: "upcoming", items: [bookingRow({ booking_id: "b2", court_name: "Court 3" })], next_cursor: null }
          : { when: "upcoming", items: [bookingRow()], next_cursor: "CUR1" }),
      },
    ]));
    renderMember(at("bookings"));

    expect(await screen.findByText(/Court 1/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: BOOKINGS_TAB_COPY.loadMore }));
    expect(await screen.findByText(/Court 3/)).toBeInTheDocument();
    // Appended, not replaced: the first page is still there.
    expect(screen.getByText(/Court 1/)).toBeInTheDocument();
    expect(stub.calls.some((c) => c.path.includes("when=upcoming&cursor=CUR1"))).toBe(true);
    expect(screen.queryByRole("button", { name: BOOKINGS_TAB_COPY.loadMore })).not.toBeInTheDocument();
  });

  it("switches to past bookings through the URL's own toggle", async () => {
    const stub = serve(baseRoutes(detailFixture(), [
      { path: `${BASE}/bookings`, body: { when: "upcoming", items: [], next_cursor: null } },
    ]));
    renderMember(at("bookings"));
    await screen.findByText(BOOKINGS_TAB_COPY.emptyUpcoming);
    fireEvent.click(screen.getByRole("radio", { name: BOOKINGS_TAB_COPY.past }));
    await waitFor(() => expect(stub.calls.some((c) => c.path.includes("when=past"))).toBe(true));
  });

  it("never reports 'nothing booked' over a failed read", async () => {
    serve(baseRoutes(detailFixture(), [unreachable(`${BASE}/bookings`)]));
    renderMember(at("bookings"));
    expect(await screen.findByRole("alert")).toHaveTextContent(BOOKINGS_TAB_COPY.failedCaveat);
    expect(screen.queryByText(BOOKINGS_TAB_COPY.emptyUpcoming)).not.toBeInTheDocument();
  });

  it("cancels through the grid's own sheet, as an admin, naming the member", async () => {
    serve(baseRoutes(detailFixture(), [
      { path: `${BASE}/bookings`, body: { when: "upcoming", items: [bookingRow()], next_cursor: null } },
      { path: "/api/v1/bookings/b1/cancellation-quote", body: { bookingId: "b1", refundCredits: 24, penaltyCredits: 0, checkedIn: false, withinPenaltyWindow: false } },
    ]));
    renderMember(at("bookings"));
    fireEvent.click(await screen.findByRole("button", { name: /^Cancel Court 1, / }));
    const sheet = await screen.findByRole("dialog");
    expect(sheet).toHaveAttribute("data-sheet", "cancel");
  });

  it("links every booking, past ones too, to its own page with its players", async () => {
    serve(baseRoutes(detailFixture(), [
      { path: `${BASE}/bookings`, body: { when: "upcoming", items: [bookingRow({ checked_in_at: "2099-09-23T16:01:00Z" })], next_cursor: null } },
    ]));
    renderMember(at("bookings"));
    const link = await screen.findByRole("link", { name: /^Players on Court 1, / });
    expect(link).toHaveAttribute("href", "/bookings/b1");
    expect(link).toHaveTextContent(DETAIL_LINKS.open);
  });

  it("offers no cancel on a booking the lights have already been on for", async () => {
    serve(baseRoutes(detailFixture(), [
      { path: `${BASE}/bookings`, body: { when: "upcoming", items: [bookingRow({ checked_in_at: "2099-09-23T16:01:00Z" })], next_cursor: null } },
    ]));
    renderMember(at("bookings"));
    await screen.findByText(/Court 1/);
    expect(screen.queryByRole("button", { name: /^Cancel Court 1/ })).not.toBeInTheDocument();
  });
});

describe("member detail — wallet tab", () => {
  beforeEach(() => { signOut(); });

  it("reads THIS member's ledger, and says the list is capped when it is", async () => {
    const rows = Array.from({ length: LEDGER_LIMIT }, (_, i) => ledgerRowFixture({ id: `l${i}`, comment: `Row ${i}` }));
    const stub = serve(baseRoutes(detailFixture(), [{ path: "/api/v1/admin/ledger/", body: rows }]));
    renderMember(at("wallet"));
    expect(await screen.findByText("Row 0")).toBeInTheDocument();
    expect(stub.calls.some((c) => c.path.includes(`userId=${MEMBER_ID}`) && c.path.includes(`limit=${LEDGER_LIMIT}`))).toBe(true);
    expect(screen.getByText(WALLET_TAB_COPY.showingLatest(LEDGER_LIMIT))).toBeInTheDocument();
  });

  it("never draws an empty ledger over a failed read", async () => {
    serve(baseRoutes(detailFixture(), [unreachable("/api/v1/admin/ledger/")]));
    renderMember(at("wallet"));
    expect(await screen.findByRole("alert")).toHaveTextContent(WALLET_TAB_COPY.failedCaveat);
    expect(screen.queryByText(WALLET_TAB_COPY.empty)).not.toBeInTheDocument();
  });
});

describe("member detail — door history (D9)", () => {
  beforeEach(() => { signOut(); });

  const doorRoutes = (page: ReturnType<typeof doorsPage> | null) => baseRoutes(detailFixture(), [
    { path: "/api/v1/admin/doors", body: { day_started_at: "2026-09-23T00:00:00+02:00", timezone: "Africa/Johannesburg", shut_all_active: false, doors: [] } },
    page ? { path: `${BASE}/doors`, body: page } : unreachable(`${BASE}/doors`),
  ]);

  it("says the look is recorded before anything is read", async () => {
    serve(doorRoutes(doorsPage([doorRow()])));
    renderMember(at("doors"));
    // Standing on the tab itself, so it is on screen whatever the (audited) read answers.
    expect((await screen.findAllByText(DOORS_TAB_COPY.audited)).length).toBeGreaterThan(0);
    expect(await screen.findByText("Front door")).toBeInTheDocument();
  });

  it("reads the member through a PATH segment, with the filters as the club log's grammar", async () => {
    const stub = serve(doorRoutes(doorsPage([doorRow()])));
    renderMember(`${at("doors")}?period=last_30d&outcome=refused`);
    await screen.findByText("Front door");
    const read = stub.calls.find((c) => c.path.startsWith(`${BASE}/doors`))!;
    expect(read.path).toContain("period=last_30d");
    expect(read.path).toContain("outcome=refused");
    expect(read.path).not.toMatch(/[?&](member|user|userId|user_id)=/);
  });

  it("shows the outcome as a word, the server's reason, and an approximate time as ≈", async () => {
    serve(doorRoutes(doorsPage([
      doorRow({ outcome: "refused", reason_text: "Refused — no live booking", time_uncertain: true, offline: true }),
    ])));
    renderMember(at("doors"));
    expect(await screen.findByText("Refused — no live booking")).toBeInTheDocument();
    expect(screen.getByText(DOORS_TAB_COPY.refused)).toBeInTheDocument();
    expect(screen.getByText(/^≈/)).toBeInTheDocument();
    expect(screen.getByText(DOORS_TAB_COPY.offlineNote)).toBeInTheDocument();
  });

  it("says nothing was recorded about the look-up when the read failed", async () => {
    serve(doorRoutes(null));
    renderMember(at("doors"));
    expect(await screen.findByRole("alert")).toHaveTextContent(DOORS_TAB_COPY.failedCaveat);
    expect(screen.queryByText(DOORS_TAB_COPY.empty)).not.toBeInTheDocument();
  });

  it("downloads the CSV WITH the session's token, never a bare link", async () => {
    const stub = serve([
      ...doorRoutes(doorsPage([doorRow()])),
      { path: `${BASE}/doors.csv`, body: "date,time\n", headers: { "content-disposition": 'attachment; filename="thandi-doors.csv"' } },
    ]);
    const created: string[] = [];
    URL.createObjectURL = ((b: Blob) => { created.push(String(b.size)); return "blob:x"; }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
    renderMember(at("doors"));
    await screen.findByText("Front door");
    expect(screen.queryByRole("link", { name: DOORS_TAB_COPY.download })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: DOORS_TAB_COPY.download }));
    await waitFor(() => expect(created).toHaveLength(1));
    const csv = stub.calls.find((c) => c.path.startsWith(`${BASE}/doors.csv`))!;
    expect(csv.headers.authorization).toMatch(/^Bearer /);
    expect(csv.path).toContain("period=last_7d");
  });
});

describe("member detail — sign-in & biometrics", () => {
  beforeEach(() => { signOut(); });

  it("removes a fingerprint only after a confirm that says what it does", async () => {
    const stub = serve(baseRoutes(detailFixture(), [
      { method: "DELETE", path: "/api/v1/admin/biometric/templates/t1", status: 204, body: null },
    ]));
    renderMember(at("access"));
    fireEvent.click(await screen.findByRole("button", { name: ACCESS_COPY.remove("Right index") }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(ACCESS_COPY.removeBody)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: ACCESS_COPY.removeConfirm }));
    await waitFor(() => expect(stub.calls.some((c) => c.method === "DELETE" && c.path.endsWith("/templates/t1"))).toBe(true));
  });

  it("asks for consent before a capture, and enrols the first finger not yet held", async () => {
    const stub = serve(baseRoutes(detailFixture(), [
      { method: "POST", path: "/api/v1/admin/biometric/enroll", body: { template_id: "t2" } },
    ]));
    renderMember(at("access"));
    fireEvent.click(await screen.findByRole("button", { name: ACCESS_COPY.enrol }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(ACCESS_COPY.consent)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: ACCESS_COPY.capture })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: ACCESS_COPY.consentGiven }));
    fireEvent.click(within(dialog).getByRole("button", { name: ACCESS_COPY.capture }));
    await waitFor(() => expect(stub.calls.some((c) => c.path === "/api/v1/admin/biometric/enroll")).toBe(true));
    expect(stub.calls.find((c) => c.path === "/api/v1/admin/biometric/enroll")?.body)
      .toMatchObject({ userId: MEMBER_ID, fingerLabel: "right-middle", consentReceiptHash: "v1" });
  });

  it("resets a password and shows the temporary one once, in a dialog", async () => {
    serve(baseRoutes(detailFixture(), [
      {
        method: "POST", path: "/api/v1/admin/members/22222222-2222-2222-2222-222222222222/reset-password",
        body: { temp_password: "Tmp-4821-xyz", email_sent_to: "thandi@example.com", member_notified: true, advice: "" },
      },
    ]));
    renderMember(at("access"));
    fireEvent.click(await screen.findByRole("button", { name: ACCESS_COPY.resetPassword }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: ACCESS_COPY.resetConfirm }));
    expect(await screen.findByText("Tmp-4821-xyz")).toBeInTheDocument();
    expect(screen.getByText(ACCESS_COPY.resetDoneSent("thandi@example.com"))).toBeInTheDocument();
  });
});
