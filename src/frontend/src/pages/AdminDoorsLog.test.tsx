import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { AdminDoorsLogPage } from "./AdminDoorsLog";
import {
  SETTINGS_FIXTURE, doorFixture, doorLogFixture, doorsServer, renderPage, signIn, signOut,
  stubFetch,
} from "../test/harness";

/**
 * The club door log — W1.3.
 *
 * <p>
 * The committee's question after a break-in, and the desk's question the spec predicted:
 * "nobody could get in through the side door all Tuesday." Under thirty seconds to an
 * answer, on a phone.
 * </p>
 *
 * <p>
 * <b>The load-bearing tests here are the absences.</b> P3 says the log filters by door, time
 * and outcome and by nothing else, and the way that breaks is not a decision somebody makes
 * — it is `DataTable`'s `search` prop, whose default would put the member's name in the
 * filter string, or a sort control on the who column, which is the same filter in another
 * shape. So this file asserts that no such control exists, and that the one sentence
 * mentioning members is the one explaining why there is no filter.
 * </p>
 */

const DOOR_ID = "99999999-9999-9999-9999-999999999999";

describe("the club door log", () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

  const open = (
    rows: Record<string, unknown>[],
    /** `doors` overrides the club's door list; everything else goes to `doorsServer`. */
    options: Parameters<typeof doorsServer>[1] & { doors?: Record<string, unknown>[] } = {},
    entries = ["/admin/doors/log"],
  ) => {
    const { doors, ...serverOptions } = options;
    const server = doorsServer(doors ?? [doorFixture()], { activity: rows, ...serverOptions });
    // A real session, because the CSV's whole defect was a request that went out without
    // one — and a stub that never sees an Authorization header cannot prove it now does.
    const whoami = signIn({ isAdmin: true });
    const stub = stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_credits: 0 } },
      { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
      ...server.routes,
    ]);
    renderPage(<AdminDoorsLogPage />, { initialEntries: entries });
    return { server, stub };
  };

  // --- the two P2 banners and the retention statement -----------------------------

  it("carries both P2 sentences, and nothing on the page can dismiss them", async () => {
    open([doorLogFixture()]);

    expect(await screen.findByText(/not who walked through/))
      .toHaveTextContent("a member who shares their QR shares entry");
    expect(screen.getByText(/no door sensor/)).toHaveTextContent("released the lock");
    // Not dismissible: dismissing one is how it stops being true for the next reader.
    expect(screen.queryByRole("button", { name: /dismiss|hide|close/i })).toBeNull();
  });

  it("states the club's own retention number", async () => {
    open([doorLogFixture()], { retentionDays: 90 });

    expect(await screen.findByText(/kept for 90 days/)).toBeInTheDocument();
  });

  it("says it in the singular for a one-day club", async () => {
    open([doorLogFixture()], { retentionDays: 1 });

    expect(await screen.findByText(/kept for 1 day and then deleted/)).toBeInTheDocument();
  });

  // --- P3: what this log may be narrowed by ---------------------------------------

  /**
   * <b>The whole of P3, as an absence.</b> Three controls, and the only mention of a member
   * anywhere is the sentence explaining that there is no member filter.
   */
  it("offers exactly three filters and nothing that narrows by a person", async () => {
    open([doorLogFixture()]);

    await screen.findByLabelText("Door");
    expect(screen.getAllByRole("combobox")).toHaveLength(3);
    expect(screen.getByLabelText("When")).toBeInTheDocument();
    expect(screen.getByLabelText("Outcome")).toBeInTheDocument();

    for (const control of [...screen.queryAllByRole("textbox"), ...screen.queryAllByRole("searchbox")]) {
      expect(control).toBeUndefined();
    }
    for (const word of [/member/i, /player/i, /person/i, /name/i]) {
      expect(screen.queryByLabelText(word)).toBeNull();
      expect(screen.queryByPlaceholderText(word)).toBeNull();
    }
    expect(screen.getByText(/It does not filter by member/))
      .toHaveTextContent("a member's own door history belongs to them, on their profile");
  });

  /** A table would be `DataTable`, and `DataTable`'s search prop is the defect. */
  it("renders no table and no sort control at all", async () => {
    open([doorLogFixture()]);

    await screen.findByText(/scans?, newest first/);
    expect(document.querySelector("table")).toBeNull();
    expect(screen.queryByRole("button", { name: /sort/i })).toBeNull();
    expect(screen.queryByRole("columnheader")).toBeNull();
  });

  // --- the filters ----------------------------------------------------------------

  it("defaults to the last 24 hours and asks the API for that range", async () => {
    const { stub } = open([doorLogFixture()]);

    await screen.findByText(/scans?, newest first/);
    expect(screen.getByLabelText("When")).toHaveValue("24h");
    const read = stub.calls.find((c) => c.path.includes("/doors/activity"));
    const from = new URL(`http://x${read!.path}`).searchParams.get("from");
    const hoursAgo = (Date.now() - new Date(from!).getTime()) / 3_600_000;
    expect(hoursAgo).toBeGreaterThan(23.9);
    expect(hoursAgo).toBeLessThan(24.1);
  });

  /** Query-string filters are what let a door page pre-filter and a link be shareable. */
  it("reads its filters out of the query string", async () => {
    const { stub } = open([doorLogFixture()], {}, [`/admin/doors/log?door=${DOOR_ID}`]);

    await screen.findByText(/scans?, newest first/);
    expect(screen.getByLabelText("Door")).toHaveValue(DOOR_ID);
    expect(stub.calls.find((c) => c.path.includes("/doors/activity"))!.path).toContain(`door=${DOOR_ID}`);
  });

  it("re-reads immediately on a filter change, with no Apply button", async () => {
    const { stub } = open([doorLogFixture()]);

    await screen.findByText(/scans?, newest first/);
    const before = stub.calls.filter((c) => c.path.includes("/doors/activity")).length;
    fireEvent.change(screen.getByLabelText("When"), { target: { value: "7d" } });

    await waitFor(() => {
      expect(stub.calls.filter((c) => c.path.includes("/doors/activity")).length).toBeGreaterThan(before);
    });
    expect(screen.queryByRole("button", { name: /apply/i })).toBeNull();
  });

  /**
   * The outcome filter's values are the chip dictionary's, so the filter control and the row
   * are the same object rather than two lists that drift.
   */
  it("offers the outcome values the rows are chipped with", async () => {
    open([doorLogFixture()]);

    await screen.findByLabelText("Outcome");
    for (const label of ["All outcomes", "Lock released", "Refused (any)", "No booking", "Too early"]) {
      expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
    }
  });

  // --- the three empty states, and the failed read --------------------------------

  it("separates a failed read from every empty state", async () => {
    const server = doorsServer([doorFixture()]);
    stubFetch([
      { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
      { path: "/api/v1/admin/doors/activity", status: 503, body: {} },
      ...server.routes,
    ]);
    renderPage(<AdminDoorsLogPage />, { initialEntries: ["/admin/doors/log"] });

    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing at the doors has changed");
    expect(screen.queryByText(/No scans at any door/)).toBeNull();
    expect(screen.queryByText(/No scans match those filters/)).toBeNull();
  });

  it("says nothing happened when nothing happened", async () => {
    open([]);

    expect(await screen.findByText("No scans at any door in the last 24 hours.")).toBeInTheDocument();
  });

  it("tells a narrowed filter how to widen", async () => {
    open([], {}, ["/admin/doors/log?outcome=refused"]);

    expect(await screen.findByText("No scans match those filters.")).toBeInTheDocument();
    expect(screen.getByText(/Try a longer time range/)).toBeInTheDocument();
  });

  /**
   * The spec's own question. An empty result for one door has two causes that look identical
   * from a log — nobody tried, or the board never reached the club — so the screen names the
   * second rather than implying the first.
   */
  /**
   * <b>C7.</b> The second sentence used to be asserted whatever the door was doing, so an
   * admin who filtered a perfectly healthy door to a quiet range was told its board might
   * not be reaching the club — and went to look for a fault that did not exist. It is
   * derived from that door's own liveness now.
   */
  it("does not blame a reporting door's board for an empty range", async () => {
    open([], {}, [`/admin/doors/log?door=${DOOR_ID}`]);

    expect(await screen.findByText(/No scans at Side door between/))
      .toHaveTextContent("It is reporting, so the club is hearing from it");
    expect(screen.queryByText(/may not be reaching the club/)).toBeNull();
    expect(screen.getByRole("link", { name: "Check it on Doors" })).toHaveAttribute("href", "/admin/doors");
  });

  it("does say so when the door really is not reporting", async () => {
    open([], { doors: [doorFixture({ last_seen_at: ago(3600) })] }, [`/admin/doors/log?door=${DOOR_ID}`]);

    expect(await screen.findByText(/No scans at Side door between/))
      .toHaveTextContent("Nothing can reach it, so if members have been using it the club would not know");
  });

  // --- paging ---------------------------------------------------------------------

  const manyRows = (count: number) => Array.from({ length: count }, (_, i) => doorLogFixture({
    at: ago(i * 60), action: "gate.denied_no_booking", reason: "no_booking",
  }));

  it("appends older scans rather than replacing them, and moves focus to the first new row", async () => {
    open(manyRows(4), { pageSize: 2 });

    await screen.findByText("2 scans, newest first");
    fireEvent.click(screen.getByRole("button", { name: "Load older scans" }));

    await waitFor(() => expect(screen.getByText("4 scans, newest first")).toBeInTheDocument());
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[2]).toHaveFocus();
  });

  it("keeps the rows it has when the next page fails, and says the ones it has are right", async () => {
    const server = doorsServer([doorFixture()], { activity: manyRows(4), pageSize: 2 });
    stubFetch([
      { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
      {
        path: "/api/v1/admin/doors/activity",
        // The first read lands; the cursored one does not.
        respond: (request) => (request.path.includes("cursor=")
          ? { __refuse: true }
          : { items: manyRows(4).slice(0, 2), next_cursor: "2", retention_days: 90 }),
        status: [200, 500],
      },
      ...server.routes,
    ]);
    renderPage(<AdminDoorsLogPage />, { initialEntries: ["/admin/doors/log"] });

    await screen.findByText("2 scans, newest first");
    fireEvent.click(screen.getByRole("button", { name: "Load older scans" }));

    expect(await screen.findByText(/Older scans could not be read/))
      .toHaveTextContent("The 2 above are still correct");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  /** A disabled control with nothing to do is furniture, so it is not rendered at all. */
  it("drops the button and says so when the range is exhausted", async () => {
    open(manyRows(2), { pageSize: 50, retentionDays: 90 });

    await screen.findByText("2 scans, newest first");
    expect(screen.queryByRole("button", { name: "Load older scans" })).toBeNull();
    expect(screen.getByText(/That is everything kept for this range/))
      .toHaveTextContent("Scans older than 90 days are deleted.");
  });

  // --- the CSV --------------------------------------------------------------------

  /**
   * <b>The CSV must export what is on screen.</b> A button that built its own query could
   * hand a committee a different set of rows from the one the admin was looking at.
   */
  it("asks for the CSV with byte-identical filters to the list", async () => {
    const { stub } = open([doorLogFixture()], {}, [`/admin/doors/log?door=${DOOR_ID}&range=7d`]);

    await screen.findByText(/scans?, newest first/);
    const listQuery = new URL(`http://x${stub.calls.find((c) => c.path.includes("/doors/activity"))!.path}`).search;

    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    await waitFor(() => {
      expect(stub.calls.some((c) => c.path.includes("activity.csv"))).toBe(true);
    });
    const csvQuery = new URL(`http://x${stub.calls.find((c) => c.path.includes("activity.csv"))!.path}`).search;
    expect(csvQuery).toBe(listQuery);
  });

  /**
   * And it goes out WITH the session's token. A bare `<a download>` navigates with no
   * Authorization header at all, so the API cannot resolve a tenant and answers a JSON 400 —
   * the download starts, cancels itself, and the page looks identical before and after.
   */
  it("fetches the CSV with the bearer token rather than navigating to it", async () => {
    const { stub } = open([doorLogFixture()]);

    await screen.findByText(/scans?, newest first/);
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));

    await waitFor(() => {
      const csv = stub.calls.find((c) => c.path.includes("activity.csv"));
      expect(csv?.headers.authorization).toBeDefined();
    });
  });

  /**
   * The note is permanent and sits at the click rather than in a dialog: a CSV is the one
   * action on this surface that moves data past every guard the product has, and a dialog is
   * something an admin dismisses.
   */
  it("says at the button what a downloaded file carries and escapes", async () => {
    open([doorLogFixture()], { retentionDays: 90 });

    expect(await screen.findByText(/Members' names are in it/))
      .toHaveTextContent("outside the club's 90-day rule");
  });

  /**
   * <b>B3 / A15 — the promise the page could not keep.</b>
   *
   * The note said "the same rows as this page". The page shows one cursor page of 50; the
   * reviewer's file held 165. And the toast then announced "50 scans downloaded" — the
   * length of the list on screen — which is the number an admin repeats to a committee.
   */
  it("promises the filters rather than the page, and never the page's length", async () => {
    open([doorLogFixture()], { retentionDays: 90 });

    const note = await screen.findByText(/every scan matching the filters above/);
    expect(note).toHaveTextContent("not just the rows on this page");
    expect(document.body.textContent).not.toContain("same rows as this page");
  });

  /**
   * B3's other half: the count comes from the SERVER's own `X-Crusaders-Rows` header, and
   * where the header is absent the sentence carries no number at all rather than the wrong
   * one.
   */
  it("announces the server's row count, not the list's length", async () => {
    const server = doorsServer([doorFixture()], { activity: [doorLogFixture()] });
    const whoami = signIn({ isAdmin: true });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_credits: 0 } },
      { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
      {
        path: "/api/v1/admin/doors/activity.csv",
        headers: {
          "content-disposition": 'attachment; filename="door-log.csv"',
          "x-crusaders-rows": "165",
        },
        body: "at,door\n",
      },
      ...server.routes,
    ]);
    renderPage(<AdminDoorsLogPage />, { initialEntries: ["/admin/doors/log"] });

    fireEvent.click(await screen.findByRole("button", { name: "Download CSV" }));
    expect(await screen.findByText("165 scans downloaded.")).toBeInTheDocument();
  });

  it("carries no number at all when the server did not send one", async () => {
    open([doorLogFixture()]);

    fireEvent.click(await screen.findByRole("button", { name: "Download CSV" }));
    const toast = await screen.findByText(/The file has downloaded/);
    expect(toast.textContent).not.toMatch(/\d/);
    expect(toast).toHaveTextContent("may be more than this page shows");
  });

  /**
   * <b>B1's "four views of ONE set", held on this side too.</b>
   *
   * The server already narrows this route to scans — it is why the reviewer's club log
   * showed no rows for a door whose own page claimed thirteen refusals. But the count here
   * is a claim an admin quotes to a committee, and the door's own feed made exactly this
   * mistake by counting whatever arrived. Counting what is a scan costs one filter and
   * cannot be wrong; trusting the route is a promise about somebody else's code.
   */
  it("counts and lists scans only, whatever the route sends", async () => {
    open([
      doorLogFixture(),
      doorLogFixture({ at: ago(60), action: "device.updated", reason: null }),
      doorLogFixture({ at: ago(120), action: "doors.shut_all", reason: null }),
    ]);

    expect(await screen.findByText("1 scan, newest first")).toBeInTheDocument();
    expect(screen.queryByText(/Someone changed this door's details/)).toBeNull();
    expect(screen.queryByText(/Every door was shut together/)).toBeNull();
  });

  /**
   * <b>B17 / A5 — the log named every row by its SLUG.</b>
   *
   * A committee reading a log after an incident saw "front-door" where the club says
   * "Front door", and the filter's own picker labelled a door that has a display name but
   * no slug "gate-44c103 — no door name yet" — the board's MAC fragment, where the admin's
   * own word for it was in `name` the whole time.
   */
  it("names a door by what the club calls it, in the rows and in the picker", async () => {
    open([doorLogFixture({ door: { id: DOOR_ID, name: "Front door", gate_key: "front-door" } })]);

    const rows = await screen.findByRole("list");
    expect(rows).toHaveTextContent("Front door");
    expect(rows.textContent).not.toContain("front-door");
  });

  it("labels an unnamed door by its display name rather than its board code", async () => {
    open([], { doors: [doorFixture({ name: "Door gate", gate_key: null })] });

    const picker = await screen.findByLabelText("Door");
    expect(picker).toHaveTextContent("Door gate — no door name yet");
    expect(picker.textContent).not.toContain("gate-0a1b2c —");
  });

  /**
   * <b>A6 — the picker collapsed to "All doors" alone when the doors read failed</b>, which
   * is indistinguishable from a club with one door; and a `?door=` already in the URL had
   * no option to select, so the control read "All doors" over a list filtered to one. The
   * rows themselves each name their own door, so a filtered view can always offer at least
   * the doors it is showing — and the page says the list may be short.
   */
  it("keeps the doors it knows about when the doors read fails, and says the list may be short", async () => {
    const whoami = signIn({ isAdmin: true });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_credits: 0 } },
      { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
      { path: "/api/v1/admin/doors/activity", body: { items: [doorLogFixture()], next_cursor: null, retention_days: 90 } },
      { path: "/api/v1/admin/doors", status: 503, body: {} },
    ]);
    renderPage(<AdminDoorsLogPage />, { initialEntries: ["/admin/doors/log"] });

    const picker = await screen.findByLabelText("Door");
    expect(picker).toHaveTextContent("Side door");
    expect(screen.getByText(/this list may be short/))
      .toHaveTextContent("The scans below are unaffected");
  });

  // --- staleness ------------------------------------------------------------------

  /** It deliberately does not poll: a list that re-sorts under a reader's finger is worse. */
  it("says when it was read and does not re-read on its own", async () => {
    vi.useFakeTimers();
    const { stub } = open([doorLogFixture()]);
    await vi.advanceTimersByTimeAsync(0);

    const before = stub.calls.filter((c) => c.path.includes("/doors/activity")).length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stub.calls.filter((c) => c.path.includes("/doors/activity")).length).toBe(before);
    vi.useRealTimers();
  });
});
