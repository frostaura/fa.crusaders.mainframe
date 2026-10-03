import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { MemberNight, MemberNightPage } from "./MemberNight";
import { AdminChangeRecordPage } from "./AdminChangeRecord";
import { CHANGES_PAGE } from "../../lib/changeRecordCopy";
import { settingDef } from "../../lib/settingsSchema";
import { memberFixture, refuse, renderPage, signIn, stubFetch, unreachable, type StubRoute } from "../../test/harness";
import { nightWindowHint } from "../../lib/nightCopy";
import type { TraceEvent, TraceView } from "../../lib/adminApi";
import { rememberClubZone } from "../../lib/clubZone";
import { NIGHT_TAB_COPY } from "../../lib/memberDetailCopy";

/**
 * A person's night, and the club's record of its own admins.
 *
 * <p>
 * These two surfaces are tested together because they are one promise seen from two sides:
 * the night page says "opening this is recorded", and the change record is where that record
 * appears and is the page that has to be able to prove nobody can delete it. A defect in
 * either makes the other a lie.
 * </p>
 *
 * <p>
 * <b>P5 moved the night onto the member (R17).</b> It is `MemberNight` inside the member page's
 * Night tab; the old `/admin/monitoring/night` is now only a picker that opens that tab. The
 * tests that drove the in-page member picker now render the night for a named member, and the
 * "nothing until a member is named" rule is kept by the picker page, which reads no night at all.
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

/** Thandi's night, as the member page's Night tab mounts it. */
function renderNight(path = "/admin/members/u1/night") {
  return renderPage(<MemberNight userId="u1" name="Thandi Mokoena" />, { initialEntries: [path] });
}

describe("a person's night", () => {
  beforeEach(() => { signIn({ isAdmin: true }); });

  it("says what looking at this costs, before anything is looked at", async () => {
    stubFetch(nightRoutes(traceView([traceEvent()])));
    renderNight();

    // The whole of the privacy exception is this sentence plus the server's audit row.
    expect((await screen.findAllByText(/Opening it is recorded/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/not here to browse/).length).toBeGreaterThan(0);
  });

  it("reads the member's night through a path segment and never a filter", async () => {
    const stub = stubFetch(nightRoutes(traceView([traceEvent()])));
    renderNight();

    await waitFor(() => expect(
      stub.calls.some((c) => c.path.startsWith("/api/v1/admin/members/u1/trace")),
    ).toBe(true));
    // A member as a QUERY parameter is the shape the doors contract forbids — somebody would
    // eventually make it optional, and an optional member filter on a log is the thing.
    expect(stub.calls.every((c) => !/[?&](member|user|userId|user_id)=/.test(c.path))).toBe(true);
    expect(await screen.findByText("Booked Court 2 for 18:00")).toBeInTheDocument();
  });

  /**
   * The club-date defect this move fixed. The page defaulted to `new Date().toISOString()` —
   * the UTC date — so a club east of Greenwich opened on yesterday after its own midnight. Here
   * the three clocks disagree on purpose: UTC and the runner (Johannesburg) say the 22nd, the
   * club (Auckland, UTC+12) says the 23rd. The club wins.
   */
  describe("with the club in a zone whose date differs from UTC's", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-22T13:00:00Z"));
      rememberClubZone("Pacific/Auckland");
    });
    afterEach(() => { vi.useRealTimers(); });

    it("opens on the CLUB's today, not UTC's and not the reader's", async () => {
      const stub = stubFetch(nightRoutes(traceView([traceEvent()], { timezone: "Pacific/Auckland", club_day: "2026-09-23" })));
      renderNight();

      await waitFor(() => expect(stub.calls.some((c) => c.path.includes("/trace?day="))).toBe(true));
      const asked = stub.calls.filter((c) => c.path.includes("/trace?day=")).map((c) => c.path);
      expect(asked.every((p) => new URLSearchParams(p.split("?")[1]).get("day") === "2026-09-23")).toBe(true);
      expect(screen.getByRole("radio", { name: "Tonight" })).toHaveAttribute("aria-checked", "true");
    });

    it("lets a ?day= in the link win over the default", async () => {
      const stub = stubFetch(nightRoutes(traceView([traceEvent()], { timezone: "Pacific/Auckland" })));
      renderNight("/admin/members/u1/night?day=2026-09-20");
      await waitFor(() => expect(stub.calls.some((c) => c.path.includes("/trace?day=2026-09-20&"))).toBe(true));
    });
  });

  it("names the actor on every card, and marks the ones where somebody acted ON the member", async () => {
    stubFetch(nightRoutes(traceView([
      traceEvent(),
      traceEvent({
        at: "2026-09-22T19:14:00.000Z",
        strand: "wallet", kind: "wallet.adjusted_by_admin",
        headline: "Minutes adjusted by the club",
        actor: { user_id: "a1", name: "Review Admin", kind: "admin", is_self: false },
      }),
    ])));
    renderNight();

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
    renderNight();

    expect(await screen.findByText("by the club's own automatic check")).toBeInTheDocument();
    expect(screen.queryByText(/an admin/)).not.toBeInTheDocument();
  });

  it("draws an hour of silence rather than closing it up", async () => {
    stubFetch(nightRoutes(traceView([
      traceEvent({ at: "2026-09-22T16:03:00.000Z" }),
      traceEvent({ at: "2026-09-22T17:07:00.000Z", kind: "door.opened", strand: "door", headline: "Lock released" }),
    ])));
    renderNight();

    // Those words: *nothing was recorded* and *nothing happened* are different claims and
    // this product can only ever make the first.
    expect(await screen.findByText("1 hour 4 minutes — nothing recorded")).toBeInTheDocument();
  });

  it("marks an approximate time in the time itself, and explains it once", async () => {
    stubFetch(nightRoutes(traceView([traceEvent({ approximate: true })])));
    renderNight();

    expect(await screen.findByText(/^≈/)).toBeInTheDocument();
    expect(screen.getByText(/came from the board's own clock/)).toBeInTheDocument();
  });

  it("says the door half may be incomplete, in the server's own 'may be'", async () => {
    stubFetch(nightRoutes(traceView([traceEvent()], {
      retention: { door_days: 90, door_horizon: "2026-06-24", door_rows_may_be_incomplete: true },
    })));
    renderNight();

    const said = (await screen.findAllByText(/may already have been deleted/))[0];
    expect(said).toHaveTextContent("That is not evidence that nobody came in.");
  });

  it("says nothing was recorded about the LOOK-UP when the read failed", async () => {
    stubFetch(nightRoutes(null));
    renderNight();

    // The server writes its audit row on a 200. Without this half, the standing notice above
    // would be a lie about the one thing this surface promises.
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was recorded about this look-up.");
  });

  it("offers the three nearest nights rather than an empty page", async () => {
    stubFetch(nightRoutes(traceView([])));
    renderNight();

    expect(await screen.findByText(/Nothing was recorded for Thandi Mokoena/)).toBeInTheDocument();
    expect(screen.getByText(/may not have uploaded yet/)).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  /**
   * The export used to be a bare `<a href>` — no Authorization header, so the API answered the
   * "download" with a JSON refusal. It is a button now (it acts: fetch, then save), and the
   * request it makes carries the session's token.
   */
  it("downloads the CSV with the session's token, and warns that the file leaves the club's rules", async () => {
    const stub = stubFetch(nightRoutes(traceView([traceEvent()]), [
      { path: "/api/v1/admin/members/u1/trace.csv", body: "at,kind\n", headers: { "content-disposition": 'attachment; filename="night.csv"' } },
    ]));
    URL.createObjectURL = (() => "blob:x") as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
    renderNight();

    expect(screen.queryByRole("link", { name: "Download CSV" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Download CSV" }));
    await waitFor(() => expect(stub.calls.some((c) => c.path.startsWith("/api/v1/admin/members/u1/trace.csv"))).toBe(true));
    expect(stub.calls.find((c) => c.path.startsWith("/api/v1/admin/members/u1/trace.csv"))?.headers.authorization).toMatch(/^Bearer /);
    expect(screen.getByText(/writes another line in the change record/)).toBeInTheDocument();
  });
});

describe("the old night route — a picker onto the member's own page (R17)", () => {
  beforeEach(() => { signIn({ isAdmin: true }); });

  /**
   * There is no list, no search and no index of traces — by design and by wire. The picker
   * reads NO night at all; it only sends the admin to the member they named.
   */
  it("reads no night, and opens the named member's Night tab", async () => {
    const stub = stubFetch(nightRoutes(traceView([traceEvent()])));
    renderPage(
      <Routes>
        <Route path="/admin/monitoring/night" element={<MemberNightPage />} />
        <Route path="/admin/members/:userId/night" element={<p>Thandi's night tab</p>} />
      </Routes>,
      { initialEntries: ["/admin/monitoring/night"] },
    );

    fireEvent.click(await screen.findByRole("combobox", { name: new RegExp(NIGHT_TAB_COPY.pickerLabel) }));
    fireEvent.click(await screen.findByRole("option", { name: /Thandi Mokoena/ }));
    expect(await screen.findByText("Thandi's night tab")).toBeInTheDocument();
    expect(stub.calls.some((c) => c.path.includes("/trace"))).toBe(false);
  });

  it("does not report the club as empty of members when the member read failed", async () => {
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      unreachable("/api/v1/admin/members/"),
    ]);
    renderPage(<MemberNightPage />);

    // Said under the field, not inside a list that has to be opened to find it (MemberCombobox).
    expect(await screen.findByText(/not the same as the club having none/)).toBeInTheDocument();
    expect(screen.queryByText("No members yet.")).not.toBeInTheDocument();
  });

  it("offers a Try again that reads the members again (review round 2, F3-16)", async () => {
    let reads = 0;
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      { path: "/api/v1/admin/members/", respond: () => (++reads === 1 ? refuse(503, { error: "down" }) : [MEMBER]) },
    ]);
    renderPage(<MemberNightPage />);

    fireEvent.click(await screen.findByRole("button", { name: NIGHT_TAB_COPY.membersRetry }));
    await waitFor(() => expect(screen.queryByText(/not the same as the club having none/)).toBeNull());
    fireEvent.click(await screen.findByRole("combobox", { name: new RegExp(NIGHT_TAB_COPY.pickerLabel) }));
    expect(await screen.findByRole("option", { name: /Thandi Mokoena/ })).toBeInTheDocument();
    expect(reads).toBe(2);
  });
});

describe("a night's money signs (review round 2, F3-14)", () => {
  beforeEach(() => { signIn({ isAdmin: true }); });

  it("writes a negative balance with the same minus as every other figure", async () => {
    stubFetch(nightRoutes(traceView([traceEvent({ amount_minutes: -50, balance_after_minutes: -100 })])));
    renderNight();
    const money = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-night-money]");
      if (!el) throw new Error("no money line yet");
      return el;
    });
    // P13: whole minutes in the app's one format — one U+2212 on the whole value, no decimals,
    // no "credits" — and a screen reader hears the words, not "h" and "min".
    expect(money).toHaveTextContent("−50 min");
    expect(money).toHaveTextContent("balance −1 h 40 min");
    expect(money.textContent).not.toMatch(/-\d|\d\.\d|credit|\bcr\b/);
    expect(money.querySelectorAll(".sr-only")[0]).toHaveTextContent("minus 50 minutes");
    expect(money.querySelectorAll(".sr-only")[1]).toHaveTextContent("minus 1 hour 40 minutes");
  });

  it("signs a movement in, and leaves a positive balance unsigned", async () => {
    stubFetch(nightRoutes(traceView([traceEvent({ amount_minutes: 60, balance_after_minutes: 135 })])));
    renderNight();
    const money = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-night-money]");
      if (!el) throw new Error("no money line yet");
      return el;
    });
    expect(money).toHaveTextContent("+1 h");
    expect(money).toHaveTextContent("balance 2 h 15 min");
  });
});

describe("the night's window, in words (review round 2, F3-10)", () => {
  it("says a whole club day as that day, never 'From 00:00 to 00:00'", () => {
    const hint = nightWindowHint({ from: "2026-09-22T00:00:00+02:00", to: "2026-09-23T00:00:00+02:00" }, "Africa/Johannesburg");
    expect(hint).not.toMatch(/00:00 to 00:00/);
    expect(hint).toMatch(/^All of .*22.*club time\.$/);
  });

  it("names both days when the window crosses midnight", () => {
    const hint = nightWindowHint({ from: "2026-09-22T18:00:00+02:00", to: "2026-09-23T02:00:00+02:00" }, "Africa/Johannesburg");
    expect(hint).toMatch(/^From 18:00 on .*22.* to 02:00 on .*23.*, club time\.$/);
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
      // P13: the server words a `*_minutes` field ("370 minutes"); the page shows it compact.
      { field: "balance_minutes", before: "270 minutes", after: "370 minutes" },
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
    expect(screen.getByText("6 hours 10 minutes")).toBeInTheDocument();
    // Rendered by the SERVER: a volunteer reading their own audit trail cannot be handed
    // minutes past midnight, and the browser is not where the club's clock lives.
    expect(screen.queryByText("1080")).not.toBeInTheDocument();
  });

  /** Review round 2, F3-7: the rows the reviewer opened, as the server sends them. */
  it("shows a collection's balance the right way round, its facts as facts, and no ids", async () => {
    stubFetch(changeRoutes([{
      ...change, area: "booking", action: "players.share_collected", headline: "Collected a member's share of a booking — Sam Okafor",
      changes: [
        { field: "collected_minutes", label: "Collected minutes", before: null, after: "100 minutes" },
        { field: "balance_after_minutes", label: "Balance after minutes", before: null, after: "-100 minutes" },
        { field: "balance_before_minutes", label: "Balance before minutes", before: null, after: "0 minutes" },
        { field: "seat", label: "Seat", before: "2", after: null },
        { field: "booking_id", label: "Booking id", before: "a5604dd3-1204-4b67-bc6b-cfca1804fa4f", after: null },
      ],
    }]));
    renderPage(<AdminChangeRecordPage />);
    fireEvent.click(await screen.findByText("Show what changed"));

    expect(screen.getByText("Balance")).toBeInTheDocument();
    expect(screen.getByText("0 minutes")).toBeInTheDocument();
    expect(screen.getByText("minus 1 hour 40 minutes")).toBeInTheDocument();
    expect(screen.getByText("Collected")).toBeInTheDocument();
    expect(screen.queryByText(/a5604dd3/)).toBeNull();
    expect(screen.queryByText(/-100/)).toBeNull();
  });

  it("says the club's retention once, not in the subtitle beside the banner (F3-14)", async () => {
    stubFetch(changeRoutes([change]));
    renderPage(<AdminChangeRecordPage />);
    await screen.findByText("Cancelled Thandi Mokoena's booking");
    // The subtitle is the page's purpose alone; the server's retention sentence sits under the list.
    expect(screen.getByText("Every admin action, in the order it happened.")).toBeInTheDocument();
    expect(screen.getAllByText(/cannot be deleted/)).toHaveLength(1);
  });

  it("admits an honest gap for a row written before the convention", async () => {
    stubFetch(changeRoutes([{ ...change, changes: null }]));
    renderPage(<AdminChangeRecordPage />);
    expect(await screen.findByText("What changed wasn't recorded for this row.")).toBeInTheDocument();
    expect(screen.queryByText("Show what changed")).not.toBeInTheDocument();
  });

  /** F3.2 (contract §8): the server pages by cursor, and the page said nothing about the rest. */
  it("says how many of the total it shows, and loads more on request, appending", async () => {
    const second = { ...change, id: "c2", headline: "Reset a member's password — Sam" };
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      { path: "/api/v1/admin/changes", body: { rows: [change], total: 2, cursor: "p2", timezone: "Africa/Johannesburg" } },
      { path: "/api/v1/admin/changes?period=last_7d&cursor=p2", body: { rows: [second], total: 2, cursor: null, timezone: "Africa/Johannesburg" } },
    ]);
    renderPage(<AdminChangeRecordPage />);
    expect(await screen.findByText("Showing 1 of 2.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: CHANGES_PAGE.loadMore }));
    expect(await screen.findByText("Reset a member's password — Sam")).toBeInTheDocument();
    expect(screen.getByText("Cancelled Thandi Mokoena's booking")).toBeInTheDocument();
    expect(screen.getByText("Showing 2 of 2.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: CHANGES_PAGE.loadMore })).not.toBeInTheDocument();
    expect(stub.calls.some((c) => c.path.includes("cursor=p2"))).toBe(true);
  });

  /** R9 X9-2: the last page takes "Load more" away; focus goes to the first row it brought. */
  it("hands focus to the first row a Load more brought, never leaving it on <body>", async () => {
    const second = { ...change, id: "c2", headline: "Reset a member's password — Sam" };
    stubFetch([
      { path: "/api/v1/whoami", body: signIn({ isAdmin: true }) },
      { path: "/api/v1/admin/changes", body: { rows: [change], total: 2, cursor: "p2", timezone: "Africa/Johannesburg" } },
      { path: "/api/v1/admin/changes?period=last_7d&cursor=p2", body: { rows: [second], total: 2, cursor: null, timezone: "Africa/Johannesburg" } },
    ]);
    renderPage(<AdminChangeRecordPage />);
    const more = await screen.findByRole("button", { name: CHANGES_PAGE.loadMore });
    more.focus();
    fireEvent.click(more);
    await screen.findByText("Reset a member's password — Sam");
    await waitFor(() => expect(document.activeElement).toHaveTextContent("Reset a member's password — Sam"));
    expect(document.activeElement?.tagName).toBe("LI");
  });

  it("labels a setting with the Settings page's caption, never its stored key", async () => {
    stubFetch(changeRoutes([{
      ...change, area: "setting", action: "settings.updated", headline: "Changed the club's settings",
      changes: [{ field: "slice_minutes", label: "Slice", before: "15", after: "30" }],
    }]));
    renderPage(<AdminChangeRecordPage />);
    fireEvent.click(await screen.findByText("Show what changed"));
    expect(screen.queryByText("slice minutes")).not.toBeInTheDocument();
    expect(screen.getByText(settingDef("slice_minutes")!.label)).toBeInTheDocument();
  });

  it("puts an action the server has no sentence for into words, never a raw code", async () => {
    stubFetch(changeRoutes([{ ...change, headline: null, action: "member_code.reset" }]));
    renderPage(<AdminChangeRecordPage />);
    expect(await screen.findByText("Member code reset")).toBeInTheDocument();
  });

  it("never renders an empty record over a failed read", async () => {
    stubFetch(changeRoutes(null));
    renderPage(<AdminChangeRecordPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/That does not mean nothing happened/);
    expect(screen.queryByText("No changes recorded in this range.")).not.toBeInTheDocument();
  });
});

/** R4 carry-over: a busy night's trace was 307 KB in one read; it comes a page at a time now. */
describe("a night read a page at a time", () => {
  beforeEach(() => { signIn({ isAdmin: true }); });

  it("asks for a page, says how many of the night are shown, and appends the next page", async () => {
    const first = traceView([traceEvent({ headline: "Booked Court 2 for 18:00" })], { total: 2, cursor: "p2" });
    const second = traceView([traceEvent({ at: "2026-09-22T16:10:00.000Z", headline: "Cancelled Court 2 for 18:00", kind: "booking.cancelled" })], { total: 2, cursor: null });
    const stub = stubFetch([
      ...nightRoutes(first).filter((r) => r.path !== "/api/v1/admin/members/u1/trace"),
      { path: "/api/v1/admin/members/u1/trace", respond: (req) => (req.path.includes("cursor=p2") ? second : first) },
    ]);
    renderNight("/admin/members/u1/night?day=2026-09-22");

    expect(await screen.findByText(NIGHT_TAB_COPY.showing(1, 2))).toBeInTheDocument();
    const firstCall = stub.calls.find((c) => c.path.startsWith("/api/v1/admin/members/u1/trace"))!;
    expect(firstCall.path).toContain("limit=100");
    fireEvent.click(screen.getByRole("button", { name: NIGHT_TAB_COPY.showMore }));
    expect(await screen.findByText(/Cancelled Court 2/)).toBeInTheDocument();
    expect(screen.getByText(/Booked Court 2/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: NIGHT_TAB_COPY.showMore })).not.toBeInTheDocument();
    const paged = stub.calls.filter((c) => c.path.startsWith("/api/v1/admin/members/u1/trace")).at(-1)!;
    expect(paged.path).toContain("cursor=p2");
    expect(paged.path).toContain("day=2026-09-22");
  });
});

/**
 * R7 E7-3 (BE commit 47c24f66): a row about ANOTHER member's money — a partner's share, the
 * automatic return's counterpart — arrives with `amount_minutes: null`, its amount in the
 * server's words. The money line is the viewed member's own, so a null draws nothing: never 0,
 * never a dash, never the other member's figure.
 */
describe("a night's money column is the viewed member's only (R7 E7-3)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("draws an amount for the member's own movement and none for another member's", async () => {
    stubFetch(nightRoutes(traceView([
      traceEvent({ strand: "wallet", kind: "share.paid", headline: "Paid Pam's share of Court 2", amount_minutes: -15, balance_after_minutes: 45 }),
      traceEvent({
        at: "2026-09-22T16:00:00.000Z", strand: "wallet", kind: "share.received",
        headline: "Pam Botha got 15 minutes back from this booking", amount_minutes: null, balance_after_minutes: null,
        subject: { user_id: "u2", name: "Pam Botha" },
      }),
    ])));
    renderNight();
    await screen.findByText("Pam Botha got 15 minutes back from this booking");
    const money = document.querySelectorAll("[data-night-money]");
    expect(money).toHaveLength(1);
    expect(money[0]).toHaveTextContent("minus 15 minutes");
  });
});

/**
 * R9 E9-3: three wallet rows inside a minute were folded into "12:13 · 3 in 1m", which hid each
 * row's amount, the balance it left and who moved it. Money is never grouped.
 * R9 X9-4: a burst's summary and a gap are said in words a screen reader reads as words.
 */
describe("a night's money is never folded into a burst (R9 E9-3, X9-4)", () => {
  beforeEach(() => { signIn({ isAdmin: true }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const wallet = (second: number, headline: string, amount: number, balance: number) => traceEvent({
    at: `2026-09-22T16:00:${String(second).padStart(2, "0")}.000Z`, strand: "wallet", kind: "minutes.moved", headline,
    amount_minutes: amount, balance_after_minutes: balance, source: "ledger", source_id: `l-${second}`,
    actor: { user_id: "a1", name: "Eve Deskadmin", kind: "admin", is_self: false },
  });

  it("draws every money row with its amount, its balance and who moved it", async () => {
    stubFetch(nightRoutes(traceView([
      wallet(1, "Paid 30 minutes for Court 2", -30, 270),
      wallet(9, "Eve Deskadmin gave them 1 hour at no charge", 60, 330),
      wallet(20, "A share of a split booking moved", 7, 337),
    ])));
    renderNight();
    await screen.findByText("Eve Deskadmin gave them 1 hour at no charge");
    expect(screen.queryByText(/ in 1 minute$/)).not.toBeInTheDocument();
    const money = document.querySelectorAll("[data-night-money]");
    expect(money).toHaveLength(3);
    expect(money[2]).toHaveTextContent("plus 7 minutes");
    expect(money[2]).toHaveTextContent("5 hours 37 minutes");
    expect(screen.getAllByText("by Eve Deskadmin, an admin")).toHaveLength(3);
  });

  it("says a burst of door tries in words, never \"in 1m\"", async () => {
    const door = (second: number) => traceEvent({
      at: `2026-09-22T16:00:${String(second).padStart(2, "0")}.000Z`, strand: "door", kind: "door.refused",
      headline: "Refused at the Front door", device_code: "GATE-1", source: "audit", source_id: `d-${second}`,
    });
    stubFetch(nightRoutes(traceView([door(1), door(20), door(40), door(59)])));
    renderNight();
    expect(await screen.findByText(/· 4 in 1 minute$/)).toBeInTheDocument();
    expect(screen.queryByText(/\din \d+m\b| in \d+m$/)).not.toBeInTheDocument();
  });
});

/**
 * R9 E9-5: a row the board wrote about the member's own scan said "at a board, with nobody
 * signed in" — as if nobody were there. The clause says who the board knew, or that the board
 * itself reported it; never that nobody was present.
 */
describe("a board's row is worded by what the board knew (R9 E9-5)", () => {
  beforeEach(() => { signIn({ isAdmin: true }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a refusal the board wrote about the member's code names the member's code", async () => {
    stubFetch(nightRoutes(traceView([traceEvent({
      strand: "court", kind: "court.activation_refused", headline: "Was turned away at Court 2 — code already used",
      actor: { user_id: null, name: null, kind: "device", is_self: false },
      subject: { user_id: "u1", name: "Thandi Mokoena" },
    })])));
    renderNight();
    await screen.findByText("Was turned away at Court 2 — code already used");
    expect(screen.getByText("with Thandi Mokoena's code, at the board")).toBeInTheDocument();
    expect(screen.queryByText(/nobody signed in/)).not.toBeInTheDocument();
  });

  it("the lights a board reported carry no claim that nobody was there", async () => {
    stubFetch(nightRoutes(traceView([traceEvent({
      strand: "lights", kind: "court.lights_on", headline: "Court 2 lights came on",
      actor: { user_id: null, name: null, kind: "device", is_self: false }, subject: null,
    })])));
    renderNight();
    await screen.findByText("Court 2 lights came on");
    expect(screen.getByText("reported by the court's board")).toBeInTheDocument();
    expect(screen.queryByText(/nobody signed in/)).not.toBeInTheDocument();
  });
});

/**
 * R10 E10-2: "who scanned" disagreed. A partner lit the organiser's court with HIS code and the
 * organiser's Night said "Checked in — by Ben" beside "lights came on — with Ava Organiser's
 * code"; a pay-for payer's lighting named the booker's code. The row stays on the owner's Night
 * (`subject`), and the clause names `code_holder` — whose code the board actually read.
 */
describe("the lights name whose code lit the court (R10 E10-2)", () => {
  beforeEach(() => { signIn({ isAdmin: true }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  /** `code_holder` is the server's new field (BE10); the shared type gains it via the integrator. */
  const litBy = (holder: { user_id: string; name: string | null } | null) => traceEvent({
    strand: "lights", kind: "court.lights_on", headline: "Court 2 lights came on",
    actor: { user_id: null, name: null, kind: "device", is_self: false },
    subject: { user_id: "u-ava", name: "Ava Organiser" },
    ...({ code_holder: holder } as Partial<TraceEvent>),
  });

  for (const [who, name] of [["an accepted partner", "Ben Partner"], ["a pay-for payer", "Pat Payer"]] as const) {
    it(`${who}'s scan names their code, not the organiser's`, async () => {
      stubFetch(nightRoutes(traceView([litBy({ user_id: "u-holder", name })])));
      renderNight();
      await screen.findByText("Court 2 lights came on");
      expect(screen.getByText(`with ${name}'s code, at the board`)).toBeInTheDocument();
      expect(screen.queryByText("with Ava Organiser's code, at the board")).not.toBeInTheDocument();
    });
  }

  it("a row written before the field still names the subject's code", async () => {
    stubFetch(nightRoutes(traceView([litBy(null)])));
    renderNight();
    await screen.findByText("Court 2 lights came on");
    expect(screen.getByText("with Ava Organiser's code, at the board")).toBeInTheDocument();
  });
});
