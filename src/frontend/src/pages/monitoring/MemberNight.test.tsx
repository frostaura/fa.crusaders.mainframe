import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemberNightPage } from "./MemberNight";
import { AdminChangeRecordPage } from "./AdminChangeRecord";
import { memberFixture, renderPage, signIn, stubFetch, unreachable, type StubRoute } from "../../test/harness";
import type { TraceEvent, TraceView } from "../../lib/adminApi";

/**
 * A person's night, and the club's record of its own admins.
 *
 * <p>
 * These two surfaces are tested together because they are one promise seen from two sides:
 * the night page says "opening this is recorded", and the change record is where that record
 * appears and is the page that has to be able to prove nobody can delete it. A defect in
 * either makes the other a lie.
 * </p>
 */

const MEMBER = memberFixture({
  user_id: "u1", full_name: "Thandi Mokoena", membership_number: "CR-0184",
});

function traceEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    at: "2026-09-22T15:52:09.000Z",
    strand: "booking", kind: "booking.made",
    headline: "Booked Court 2 for 18:00",
    actor: { user_id: "u1", name: "Thandi Mokoena", kind: "member", is_self: true },
    subject: { user_id: "u1", name: "Thandi Mokoena" },
    ...overrides,
  };
}

function traceView(events: TraceEvent[], overrides: Partial<TraceView> = {}): TraceView {
  return {
    member: { user_id: "u1", name: "Thandi Mokoena", membership_number: "CR-0184" },
    club_day: "2026-09-22",
    range: { from: "2026-09-22T00:00:00+02:00", to: "2026-09-23T00:00:00+02:00" },
    timezone: "Africa/Johannesburg",
    retention: { audit_days: 730, door_days: 90, door_horizon: "2026-06-24", door_rows_may_be_incomplete: false },
    events,
    total: events.length,
    ...overrides,
  };
}

const nightRoutes = (view: TraceView | null, extra: StubRoute[] = []): StubRoute[] => [
  { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
  { path: "/api/v1/admin/members/u1/trace", ...(view ? { body: view } : { status: 500, body: { error: "boom" } }) },
  // Declared AFTER the trace route on purpose: the stub sorts by longest prefix, so
  // `/admin/members/u1/trace` wins over `/admin/members/` for the trace call and this one
  // still answers the member list.
  { path: "/api/v1/admin/members/", body: [MEMBER] },
  ...extra,
];

/** Pick Thandi out of the combobox, which is how every case below starts. */
async function pickThandi() {
  const box = await screen.findByRole("combobox", { name: /Which member/ });
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: "tha" } });
  fireEvent.mouseDown(await screen.findByRole("button", { name: /Thandi Mokoena/ }));
}

describe("a person's night", () => {
  beforeEach(() => { signIn({ isAdmin: true }); });

  it("says what looking at this costs, before anything is looked at", async () => {
    stubFetch(nightRoutes(traceView([traceEvent()])));
    renderPage(<MemberNightPage />);

    // The whole of the privacy exception is this sentence plus the server's audit row.
    expect((await screen.findAllByText(/Opening it is recorded/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/not here to browse/).length).toBeGreaterThan(0);
  });

  /**
   * There is no list, no search and no index of traces — by design and by wire. You cannot
   * discover a person here; you can only ask about one you already named.
   */
  it("shows nothing at all until a member has been named, and says why the date is dead", async () => {
    stubFetch(nightRoutes(traceView([traceEvent()])));
    renderPage(<MemberNightPage />);

    expect(await screen.findByText(/Pick a member first/)).toBeInTheDocument();
    // A greyed control with no explanation is a dead end somebody stares at.
    expect(screen.getByLabelText("Which night?")).toBeDisabled();
  });

  it("reads the night once a member is named, through a path segment and never a filter", async () => {
    const stub = stubFetch(nightRoutes(traceView([traceEvent()])));
    renderPage(<MemberNightPage />);
    await pickThandi();

    await waitFor(() => expect(
      stub.calls.some((c) => c.path.startsWith("/api/v1/admin/members/u1/trace")),
    ).toBe(true));
    // A member as a QUERY parameter is the shape the doors contract forbids — somebody would
    // eventually make it optional, and an optional member filter on a log is the thing.
    expect(stub.calls.every((c) => !/[?&](member|user|userId|user_id)=/.test(c.path))).toBe(true);
    expect(await screen.findByText("Booked Court 2 for 18:00")).toBeInTheDocument();
  });

  it("names the actor on every card, and marks the ones where somebody acted ON the member", async () => {
    stubFetch(nightRoutes(traceView([
      traceEvent(),
      traceEvent({
        at: "2026-09-22T19:14:00.000Z",
        strand: "wallet", kind: "wallet.adjusted_by_admin",
        headline: "Credit adjusted by the club",
        actor: { user_id: "a1", name: "Review Admin", kind: "admin", is_self: false },
      }),
    ])));
    renderPage(<MemberNightPage />);
    await pickThandi();

    expect(await screen.findByText("by Thandi Mokoena themselves")).toBeInTheDocument();
    expect(screen.getByText("by Review Admin, an admin")).toBeInTheDocument();
  });

  /**
   * The backend defect this is written against: `is_admin` is NOT "the actor is not the
   * subject", because that makes every automatic no-show sweep claim an admin did it. A
   * member disputing a penalty is entitled to be told it was the club's own automatic check.
   */
  it("says the club's automatic check did it, rather than blaming an admin", async () => {
    stubFetch(nightRoutes(traceView([traceEvent({
      kind: "booking.no_show", headline: "Marked as a no-show",
      actor: { user_id: null, name: null, kind: "system", is_self: false },
    })])));
    renderPage(<MemberNightPage />);
    await pickThandi();

    expect(await screen.findByText("by the club's own automatic check")).toBeInTheDocument();
    expect(screen.queryByText(/an admin/)).not.toBeInTheDocument();
  });

  it("draws an hour of silence rather than closing it up", async () => {
    stubFetch(nightRoutes(traceView([
      traceEvent({ at: "2026-09-22T16:03:00.000Z" }),
      traceEvent({ at: "2026-09-22T17:07:00.000Z", kind: "door.opened", strand: "door", headline: "Lock released" }),
    ])));
    renderPage(<MemberNightPage />);
    await pickThandi();

    // Those words: *nothing was recorded* and *nothing happened* are different claims and
    // this product can only ever make the first.
    expect(await screen.findByText("1h 04m — nothing recorded")).toBeInTheDocument();
  });

  it("marks an approximate time in the time itself, and explains it once", async () => {
    stubFetch(nightRoutes(traceView([traceEvent({ approximate: true })])));
    renderPage(<MemberNightPage />);
    await pickThandi();

    expect(await screen.findByText(/^≈/)).toBeInTheDocument();
    expect(screen.getByText(/came from the board's own clock/)).toBeInTheDocument();
  });

  it("says the door half may be incomplete, in the server's own 'may be'", async () => {
    stubFetch(nightRoutes(traceView([traceEvent()], {
      retention: { door_days: 90, door_horizon: "2026-06-24", door_rows_may_be_incomplete: true },
    })));
    renderPage(<MemberNightPage />);
    await pickThandi();

    const said = (await screen.findAllByText(/may already have been deleted/))[0];
    expect(said).toHaveTextContent("That is not evidence that nobody came in.");
  });

  it("says nothing was recorded about the LOOK-UP when the read failed", async () => {
    stubFetch(nightRoutes(null));
    renderPage(<MemberNightPage />);
    await pickThandi();

    // The server writes its audit row on a 200. Without this half, the standing notice above
    // would be a lie about the one thing this surface promises.
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was recorded about this look-up.");
  });

  it("offers the three nearest nights rather than an empty page", async () => {
    stubFetch(nightRoutes(traceView([])));
    renderPage(<MemberNightPage />);
    await pickThandi();

    expect(await screen.findByText(/Nothing was recorded for Thandi Mokoena/)).toBeInTheDocument();
    expect(screen.getByText(/may not have uploaded yet/)).toBeInTheDocument();
  });

  it("warns that the download leaves the club's rules behind", async () => {
    stubFetch(nightRoutes(traceView([traceEvent()])));
    renderPage(<MemberNightPage />);
    await pickThandi();

    expect(await screen.findByRole("link", { name: "Download CSV" })).toBeInTheDocument();
    expect(screen.getByText(/writes another line in the change record/)).toBeInTheDocument();
  });

  it("does not report the club as empty of members when the member read failed", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      unreachable("/api/v1/admin/members/"),
    ]);
    renderPage(<MemberNightPage />);

    fireEvent.focus(await screen.findByRole("combobox", { name: /Which member/ }));
    expect(await screen.findByText(/not the same as the club having none/)).toBeInTheDocument();
    expect(screen.queryByText("No members yet.")).not.toBeInTheDocument();
  });
});

describe("the admin change record", () => {
  const changeRoutes = (rows: unknown[] | null): StubRoute[] => [
    { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
    {
      path: "/api/v1/admin/changes",
      ...(rows
        ? { body: { rows, total: rows.length, timezone: "Africa/Johannesburg", retention: "kept indefinitely — these records cannot be deleted" } }
        : { status: 500, body: { error: "boom" } }),
    },
  ];

  const change = {
    id: "c1",
    occurred_at: "2026-09-21T18:31:00.000Z",
    actor: { user_id: "a1", name: "Review Admin", email: null },
    area: "booking",
    action: "booking.cancelled_by_admin",
    headline: "Cancelled Thandi Mokoena's booking",
    subject: { kind: "booking", id: "b1", label: "Court 1 · Mon 21 Sept 21:00" },
    reason: "Court 1 lights faulty",
    changes: [
      { field: "booking_status", before: "Confirmed", after: "Cancelled" },
      { field: "balance_credits", before: "270.00 cr", after: "370.00 cr" },
    ],
  };

  beforeEach(() => { signIn({ isAdmin: true }); });

  /**
   * <b>The one property this page must be able to prove.</b> "These records become
   * non-deletable even by admins" is the requirement; a page that says so and also carries a
   * delete control has said nothing.
   */
  it("carries no delete or edit control anywhere in its DOM, and says so", async () => {
    stubFetch(changeRoutes([change]));
    renderPage(<AdminChangeRecordPage />);
    await screen.findByText("Cancelled Thandi Mokoena's booking");

    // `queryAll`, not `getAll`: this page legitimately has no buttons at all — every control
    // on it either reads or filters — and a matcher that throws on an empty set would fail
    // for the opposite of the reason this test exists.
    const controls = [...screen.queryAllByRole("button"), ...screen.queryAllByRole("link")]
      .map((c) => c.textContent ?? "");
    expect(controls.some((t) => /delete|remove|edit|undo/i.test(t))).toBe(false);
    expect(screen.getAllByText(/Nobody can delete these from the app/).length).toBeGreaterThan(0);
  });

  /**
   * And the claim stops exactly where the software's guarantee stops. The REVOKE only means
   * anything if the runtime is not the table's owner, and today it runs its own migrations —
   * so "tamper-proof" would be a promise the deployment does not keep.
   */
  it("does not claim more than the software can guarantee", async () => {
    stubFetch(changeRoutes([change]));
    renderPage(<AdminChangeRecordPage />);
    await screen.findByText("Cancelled Thandi Mokoena's booking");

    expect(document.body.textContent).not.toMatch(/tamper.?proof|immutable|impossible to change/i);
  });

  it("takes its retention sentence from the server rather than inventing a number", async () => {
    stubFetch(changeRoutes([change]));
    renderPage(<AdminChangeRecordPage />);
    expect(await screen.findByText(/kept indefinitely — these records cannot be deleted/)).toBeInTheDocument();
  });

  it("shows before and after, already rendered, when somebody asks", async () => {
    stubFetch(changeRoutes([change]));
    renderPage(<AdminChangeRecordPage />);

    fireEvent.click(await screen.findByText("Show what changed"));
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(screen.getByText("370.00 cr")).toBeInTheDocument();
    // Rendered by the SERVER: a volunteer reading their own audit trail cannot be handed
    // minutes past midnight, and the browser is not where the club's clock lives.
    expect(screen.queryByText("1080")).not.toBeInTheDocument();
  });

  it("admits an honest gap for a row written before the convention", async () => {
    stubFetch(changeRoutes([{ ...change, changes: null }]));
    renderPage(<AdminChangeRecordPage />);
    expect(await screen.findByText("What changed wasn't recorded for this row.")).toBeInTheDocument();
    expect(screen.queryByText("Show what changed")).not.toBeInTheDocument();
  });

  it("never renders an empty record over a failed read", async () => {
    stubFetch(changeRoutes(null));
    renderPage(<AdminChangeRecordPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/That does not mean nothing happened/);
    expect(screen.queryByText("No changes recorded in this range.")).not.toBeInTheDocument();
  });
});
