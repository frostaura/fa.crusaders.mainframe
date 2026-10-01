import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { AdminDoorsLogPage } from "./AdminDoorsLog";
import {
  SETTINGS_FIXTURE, doorFixture, doorLogFixture, doorsServer, renderPage, signIn, signOut,
  stubFetch,
} from "../test/harness";
// The date picker's calendar is a lazy chunk (P10). Loaded here, once, so opening a picker in a
// test resolves from the module cache instead of racing a cold transform under a loaded runner.
import "@/components/ui/date-picker-calendar";

/**
 * The three filters are design-system Selects (P3, R7 — they were native selects), so a
 * choice is made the way a pointer makes it and the options exist only while the list is open.
 */
function openPicker(label: string) {
  fireEvent.pointerDown(screen.getByRole("combobox", { name: label }), { button: 0, ctrlKey: false, pointerType: "mouse" });
}
async function choose(label: string, option: string | RegExp) {
  openPicker(label);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}
/** The picker, found by its label once the page has it. */
const picker = (label: string) => screen.findByRole("combobox", { name: label });

/**
 * A longer per-test timeout than the 5-second default, for this file only (R3, integrator: it
 * failed only under heavy load). Each case renders the whole log page, and one walks a calendar
 * month by month to a fixed day — well under a second on a quiet machine, past five with five fix
 * lanes and a backend suite sharing it. The assertions are untouched; only the time allowed is.
 */
vi.setConfig({ testTimeout: 20_000 });


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
    entries = ["/admin/monitoring/doors/log"],
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

    await picker("Door");
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

    await screen.findByText(/newest first/);
    expect(document.querySelector("table")).toBeNull();
    expect(screen.queryByRole("button", { name: /sort/i })).toBeNull();
    expect(screen.queryByRole("columnheader")).toBeNull();
  });

  // --- the filters ----------------------------------------------------------------

  /**
   * <b>A4.</b> The page used to build "now minus 24 hours" itself and send a `from` — a
   * second opinion about the club's day, and a different instant every time it was called,
   * which is why the CSV had to be handed the list's own copy of it. The range is the
   * server's now: one parameter, resolved in the club's zone.
   */
  it("defaults to the last 24 hours and asks the server to resolve it", async () => {
    const { stub } = open([doorLogFixture()]);

    await screen.findByText(/newest first/);
    expect(await picker("When")).toHaveTextContent("Last 24 hours");
    const read = new URL(`http://x${stub.calls.find((c) => c.path.includes("/doors/activity"))!.path}`);
    expect(read.searchParams.get("period")).toBe("last_24h");
    expect(read.searchParams.get("from")).toBeNull();
    expect(read.searchParams.get("day")).toBeNull();
  });

  /**
   * <b>A4 — the six ways a club actually asks "when".</b> "Last 24 hours" is rolling, and a
   * chair exporting "yesterday's" scans after an incident was handed half of yesterday and
   * half of today with nothing on the page saying so.
   */
  it("offers Today, Yesterday and a specific day as well as the rolling windows", async () => {
    open([doorLogFixture()]);

    await picker("When");
    openPicker("When");
    for (const label of ["Today", "Yesterday", "Last 24 hours", "Last 7 days", "Last 30 days", "A specific day"]) {
      expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
    }
  });

  it("sends the club-local period the club picked, and never two ranges at once", async () => {
    const { stub } = open([doorLogFixture()], {}, ["/admin/monitoring/doors/log?range=yesterday"]);

    // Yesterday genuinely holds none of today's rows, so the page settles on its empty state
    // — which is itself the point: the window is a calendar day, not a rolling 24 hours.
    await screen.findByText(/No scans/);
    const read = new URL(`http://x${stub.calls.find((c) => c.path.includes("/doors/activity"))!.path}`);
    expect(read.searchParams.get("period")).toBe("yesterday");
    // WIRE-R2 §3: more than one of period / day / from-to is a 400 `range_conflict`.
    expect(read.searchParams.get("day")).toBeNull();
    expect(read.searchParams.get("from")).toBeNull();
  });

  it("asks for one club-local day, by day, once a day is chosen", async () => {
    const { stub } = open([doorLogFixture()], {}, ["/admin/monitoring/doors/log?range=day&day=2026-09-20"]);

    await screen.findByRole("button", { name: /^Which day/ });
    const read = new URL(`http://x${stub.calls.filter((c) => c.path.includes("/doors/activity")).at(-1)!.path}`);
    expect(read.searchParams.get("day")).toBe("2026-09-20");
    expect(read.searchParams.get("period")).toBeNull();
  });

  /** A typo in a shared link is not turned into a failed read: the API answers 400 `day_invalid`. */
  /**
   * <b>A-L3 / R3-12 supersedes the second half of this.</b>
   *
   * A malformed `?day=` still never reaches the API — that part is unchanged and is why the
   * request is checked at all. What has changed is what the page does INSTEAD: it used to
   * fall back to `period=last_24h`, so the When control read "A specific day" over a rolling
   * window, with nothing on the page reconciling the two. It asks for the day now and lists
   * nothing.
   */
  it("does not send a malformed day, and does not quietly list something else", async () => {
    const { stub } = open([doorLogFixture()], {}, ["/admin/monitoring/doors/log?range=day&day=20-09-2026"]);

    await screen.findByRole("button", { name: /^Which day/ });
    expect(stub.calls.find((c) => c.path.includes("/doors/activity"))).toBeUndefined();
    expect(screen.getByRole("status")).toHaveTextContent("Pick a day to see its scans");
    expect(document.body.textContent).not.toContain("Showing 1 scan");
  });

  /**
   * <b>C-H2 / R3-12 — the date field could not be typed into.</b>
   *
   * Every keystroke went to the query string, so a typed date published `day=2`, `day=20`,
   * `day=200920-02-06` … to a bookmarkable URL. P3 retires the typing half outright: the
   * field is the club-day DatePicker, which can only produce a whole club day. The invariant
   * kept is the one that mattered — exactly ONE complete day reaches the wire.
   */
  it("commits only a whole picked day to the URL", async () => {
    const { stub } = open([doorLogFixture()], {}, ["/admin/monitoring/doors/log?range=day"]);

    fireEvent.click(await screen.findByRole("button", { name: /^Which day/ }));
    // The calendar is its own lazily loaded chunk (P10): let it arrive before walking it.
    await screen.findByRole("button", { name: /next month/i });
    const target = "2026-09-20";
    for (let step = 0; step < 60 && !document.querySelector(`button[data-day="${target}"]`); step++) {
      // The calendar opens on the CLUB's month; walk to the fixture's day in whichever direction it
      // lies, read off the month on show — UTC's month differs from the club's for two hours at
      // every month's end (it did, 2026-09-30 22:30 UTC; gotchas-clock's UTC-midnight family).
      const shown = document.querySelector("button[data-day]:not([data-outside])")?.getAttribute("data-day") ?? "";
      const back = shown.slice(0, 7) > target.slice(0, 7);
      fireEvent.click(screen.getByRole("button", { name: back ? /previous month/i : /next month/i }));
    }
    fireEvent.click(document.querySelector<HTMLElement>(`button[data-day="${target}"]`)!);

    await waitFor(() => {
      const days = stub.calls
        .filter((c) => c.path.includes("/doors/activity"))
        .map((c) => new URL(`http://x${c.path}`).searchParams.get("day"));
      expect(days).toEqual([target]);
    });
  });

  /**
   * <b>A4's other half.</b> The page states the range the SERVER resolved, in words, above
   * the rows — not a second client-side computation, which is a different instant from the
   * one the rows were read with.
   */
  it("states the exact resolved range in words, from the server's own answer", async () => {
    open([doorLogFixture()], {}, ["/admin/monitoring/doors/log?range=yesterday"]);

    expect(await screen.findByText(/^Scans from .* to .*, club time\.$/)).toBeInTheDocument();
  });

  /**
   * <b>And it is a UTC instant on the wire, rendered as CLUB wall time.</b>
   *
   * The backend lane's final wire sends `range.from` / `range.to` as `…Z`, not club-offset.
   * A page that printed either as it arrived would date a club's midnight two hours early
   * — and on this club's own day boundary, on the wrong day. The whole point of A4 was that
   * the range is resolved in the club's zone; printing it in the viewer's would hand it
   * straight back.
   */
  it("prints a UTC range as the club's own wall clock, on the club's own day", async () => {
    /*
      The club is in New York and the runner's clock is pinned to Africa/Johannesburg, and
      that gap is the whole fixture: a page that simply drops the zone falls back to the
      RUNNER's, which in every other fixture on this surface happens to be the club's — so
      the bug renders correctly and the test passes. Varying the fixture rather than the
      code, which is what this suite keeps learning.

      22:30 UTC is 18:30 in New York and 00:30 the NEXT DAY in Johannesburg, so the clock
      and the date both move.
    */
    open([doorLogFixture()], {
      range: { from: "2026-09-19T22:30:00Z", to: "2026-09-20T05:00:00Z" },
      timezone: "America/New_York",
    }, ["/admin/monitoring/doors/log?range=yesterday"]);

    const line = await screen.findByText(/^Scans from .* to .*, club time\.$/);
    expect(line).toHaveTextContent("18:30");
    expect(line).toHaveTextContent("01:00");
    // Neither the raw UTC instant nor the reader's own zone.
    expect(line.textContent).not.toContain("22:30");
    expect(line.textContent).not.toContain("00:30");
  });

  /** Query-string filters are what let a door page pre-filter and a link be shareable. */
  it("reads its filters out of the query string", async () => {
    const { stub } = open([doorLogFixture()], {}, [`/admin/monitoring/doors/log?door=${DOOR_ID}`]);

    await screen.findByText(/newest first/);
    expect(await picker("Door")).not.toHaveTextContent("All doors");
    expect(stub.calls.find((c) => c.path.includes("/doors/activity"))!.path).toContain(`door=${DOOR_ID}`);
  });

  it("re-reads immediately on a filter change, with no Apply button", async () => {
    const { stub } = open([doorLogFixture()]);

    await screen.findByText(/newest first/);
    const before = stub.calls.filter((c) => c.path.includes("/doors/activity")).length;
    await choose("When", "Last 7 days");

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

    await picker("Outcome");
    openPicker("Outcome");
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
    renderPage(<AdminDoorsLogPage />, { initialEntries: ["/admin/monitoring/doors/log"] });

    /*
     * C5: the failure goes through the ONE polite region this page has, rather than through a
     * second live region beside it. The reviewer's finding was the mirror of this — the count
     * lived in a `role="status"` that existed only while there were rows, so narrowing the log
     * to an EMPTY result announced nothing at all. One region, four outcomes, always mounted.
     */
    expect(await screen.findByRole("status")).toHaveTextContent("Nothing at the doors has changed");
    expect(screen.queryAllByRole("status")).toHaveLength(1);
    expect(screen.queryByText(/No scans at any door/)).toBeNull();
    expect(screen.queryByText(/No scans match those filters/)).toBeNull();
  });

  /**
   * <b>C5 — the region is there before there is anything to say, and stays.</b> It is removed
   * regions that announce nothing; a region that is merely empty announces its next value.
   */
  it("keeps one polite region through loading, a result and an empty result", async () => {
    open([doorLogFixture()]);

    expect(screen.getAllByRole("status")).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/newest first/));

    await choose("Outcome", "Too early");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No scans match those filters."));
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("says nothing happened when nothing happened", async () => {
    open([]);

    expect(await screen.findByText("No scans at any door in the last 24 hours.")).toBeInTheDocument();
  });

  it("tells a narrowed filter how to widen", async () => {
    open([], {}, ["/admin/monitoring/doors/log?outcome=refused"]);

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
    open([], {}, [`/admin/monitoring/doors/log?door=${DOOR_ID}`]);

    expect(await screen.findByText(/No scans at Side door between/))
      .toHaveTextContent("It is reporting, so the club is hearing from it");
    expect(screen.queryByText(/may not be reaching the club/)).toBeNull();
    expect(screen.getByRole("link", { name: "Check it on Doors" })).toHaveAttribute("href", "/admin/monitoring/doors");
  });

  it("does say so when the door really is not reporting", async () => {
    open([], { doors: [doorFixture({ last_seen_at: ago(3600) })] }, [`/admin/monitoring/doors/log?door=${DOOR_ID}`]);

    expect(await screen.findByText(/No scans at Side door between/))
      .toHaveTextContent("Nothing can reach it, so if members have been using it the club would not know");
  });

  // --- paging ---------------------------------------------------------------------

  const manyRows = (count: number) => Array.from({ length: count }, (_, i) => doorLogFixture({
    at: ago(i * 60), action: "gate.denied_no_booking", reason: "no_booking",
  }));

  it("appends older scans rather than replacing them, and moves focus to the first new row", async () => {
    open(manyRows(4), { pageSize: 2 });

    await screen.findByText(/Showing 2 of 4 scans in this range, newest first./);
    fireEvent.click(screen.getByRole("button", { name: "Load older scans" }));

    await waitFor(() => expect(screen.getByText(/Showing all 4 scans in this range/)).toBeInTheDocument());
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    // Focus moves after the rows render (focusAfterAction's backoff), not in the same tick — wait for it.
    await waitFor(() => expect(rows[2]).toHaveFocus());
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
    renderPage(<AdminDoorsLogPage />, { initialEntries: ["/admin/monitoring/doors/log"] });

    await screen.findByText(/Showing 2 scans so far/);
    fireEvent.click(screen.getByRole("button", { name: "Load older scans" }));

    expect(await screen.findByText(/Older scans could not be read/))
      .toHaveTextContent("The 2 above are still correct");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  /** A disabled control with nothing to do is furniture, so it is not rendered at all. */
  it("drops the button and says so when the range is exhausted", async () => {
    open(manyRows(2), { pageSize: 50, retentionDays: 90 });

    await screen.findByText(/Showing all 2 scans in this range/);
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
    const { stub } = open([doorLogFixture()], {}, [`/admin/monitoring/doors/log?door=${DOOR_ID}&range=7d`]);

    await screen.findByText(/newest first/);
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

    await screen.findByText(/newest first/);
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
    renderPage(<AdminDoorsLogPage />, { initialEntries: ["/admin/monitoring/doors/log"] });

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

    // R3-20: "so far" at the END of a list is what the reviewer could not get past — there
    // is no further cursor here, so the page knows it is showing all of them.
    expect(await screen.findByText(/Showing all 1 scan in this range/)).toBeInTheDocument();
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

  /**
   * <b>A11 reverses half of this.</b> The option used to read "Door gate — no door name yet",
   * which presents the auto-registration placeholder as the club's own word for the board and
   * then contradicts it in the same option. "Door gate" is what every unnamed door in the club
   * is called, so it names none of them.
   */
  it("labels an unnamed door as an unnamed scanner with its board code", async () => {
    open([], { doors: [doorFixture({ name: "Door gate", gate_key: null })] });

    await picker("Door");
    openPicker("Door");
    const list = await screen.findByRole("listbox");
    expect(list).toHaveTextContent("Unnamed scanner (gate-0a1b2c)");
    expect(list.textContent).not.toContain("Door gate");
  });

  /** A door the club HAS named keeps its name, whether or not it has a key. */
  it("keeps a named door's own name in the picker", async () => {
    open([], { doors: [doorFixture({ name: "Front door", gate_key: null })] });

    await picker("Door");
    openPicker("Door");
    expect(await screen.findByRole("option", { name: "Front door — no door name yet" })).toBeInTheDocument();
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
    renderPage(<AdminDoorsLogPage />, { initialEntries: ["/admin/monitoring/doors/log"] });

    await picker("Door");
    openPicker("Door");
    expect(await screen.findByRole("listbox")).toHaveTextContent("Side door");
    expect(screen.getByText(/this list may be short/))
      .toHaveTextContent("The scans below are unaffected");
  });

  // --- A1 / E-C1 / C1: the door that is gone ---------------------------------------

  /**
   * <b>The critical of this round, found independently by three reviewers.</b>
   *
   * A reviewer deleted a door and `/admin/monitoring/doors/log` became a blank white page for the whole
   * club: rows arrived with `door: null`, the page read `.name` off it, and the whole
   * document unmounted. It was reachable four ways — a `?door=<deleted id>` link, the Outcome
   * filter, the range, and "Load older scans" with no warning at all.
   *
   * <p>
   * The ruling (A2) is that the history is NOT destroyed: deleting a door deletes no scan
   * rows, and the row carries what it stored at write time.
   * </p>
   */
  it("renders a row whose door was deleted, under the name the row stored", async () => {
    open([doorLogFixture({
      door: { id: null, name: "Side door", gate_key: "side-door", removed: true },
    })]);

    const rows = await screen.findByRole("list");
    expect(rows).toHaveTextContent("Side door");
    expect(rows).toHaveTextContent(/since been removed/i);
    expect(document.body.textContent).not.toBe("");
  });

  /** And the shape the wire says can never happen, which is the shape that shipped. */
  it("survives a row with no door at all rather than blanking the page", async () => {
    open([doorLogFixture({ door: null })]);

    expect(await screen.findByText(/newest first/)).toBeInTheDocument();
    expect(screen.getByRole("list")).toHaveTextContent(/since been removed/i);
  });

  /**
   * <b>The suite guard.</b> A finding the tests could not see is also a test-suite defect:
   * nothing fed the log renderer a row with a null in it. This feeds it every nullable field
   * nulled at once — the row the API is not supposed to be able to send.
   */
  it("renders a row with every nullable field null", async () => {
    open([doorLogFixture({
      door: { id: null, name: null, gate_key: null, removed: true },
      reason: null, member: null, fingerprint: null, delivered_at: null,
      action: "gate.denied_no_booking",
    })]);

    expect(await screen.findByText(/newest first/)).toBeInTheDocument();
    expect(screen.getByRole("list")).toHaveTextContent(/door that has since been removed/i);
  });

  /** E-C1: "Load older scans" reached a removed door's rows and the page went white. */
  it("survives a removed door arriving only on the SECOND page", async () => {
    open([
      doorLogFixture(),
      doorLogFixture({ at: ago(60) }),
      doorLogFixture({ at: ago(120), door: null }),
      doorLogFixture({ at: ago(180), door: { id: null, name: null, gate_key: null, removed: true } }),
    ], { pageSize: 2 });

    await screen.findByText(/Showing 2 of 4 scans/);
    fireEvent.click(screen.getByRole("button", { name: "Load older scans" }));

    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(4));
    expect(screen.getByRole("list")).toHaveTextContent(/since been removed/i);
  });

  /**
   * <b>A2 — deleting a door made its whole history unreachable from this page.</b>
   *
   * Its own page 404s, it was not in this picker, and a reviewer reading the delete confirm
   * concluded the records had been destroyed. They had not: the rows stay under the name they
   * stored until the club's retention rule takes them. This is how somebody gets to them.
   */
  it("offers the doors that are gone, in their own group, by the name their rows stored", async () => {
    open([doorLogFixture()], { removedDoors: [{ key: "side-door", name: "Side door", gate_key: "side-door" }] });

    await picker("Door");
    openPicker("Door");
    const group = await screen.findByRole("group", { name: "Removed doors" });
    expect(group).toHaveTextContent("Side door");
  });

  it("filters to a removed door by the key its rows stored, never by an id it has not got", async () => {
    const { stub } = open([doorLogFixture()], {
      removedDoors: [{ key: "side-door", name: "Side door", gate_key: "side-door" }],
    });

    await picker("Door");
    await choose("Door", "Side door");

    await waitFor(() => {
      const read = new URL(`http://x${stub.calls.filter((c) => c.path.includes("/doors/activity")).at(-1)!.path}`);
      expect(read.searchParams.get("removed_door")).toBe("side-door");
      // Never both: the API answers 400 for the pair (WIRE-R2 §1).
      expect(read.searchParams.get("door")).toBeNull();
    });
  });

  /**
   * <b>The other direction, which the pair above does not cover.</b>
   *
   * The backend lane's final wire makes `door` and `removed_door` ONE filter slot: both,
   * with different values, is a 400 `door_invalid` rather than a narrower result. The
   * dangerous direction is this one — a link somebody was sent carries `?door=`, and
   * picking a removed door from the group has to CLEAR it rather than add beside it.
   */
  it("clears a door already in the URL when a removed door is chosen", async () => {
    const { stub } = open([doorLogFixture()], {
      removedDoors: [{ key: "side-door", name: "Side door", gate_key: "side-door" }],
    }, [`/admin/monitoring/doors/log?door=${DOOR_ID}`]);

    await picker("Door");
    await choose("Door", "Side door");

    await waitFor(() => {
      const read = new URL(`http://x${stub.calls.filter((c) => c.path.includes("/doors/activity")).at(-1)!.path}`);
      expect(read.searchParams.get("removed_door")).toBe("side-door");
      expect(read.searchParams.get("door")).toBeNull();
    });
  });

  it("clears a removed door when a live one is chosen instead", async () => {
    const { stub } = open([doorLogFixture()], {
      removedDoors: [{ key: "side-door", name: "Side door", gate_key: "side-door" }],
    }, ["/admin/monitoring/doors/log?removed_door=side-door"]);

    await picker("Door");
    openPicker("Door");
    const live = (await screen.findAllByRole("option")).find((o) => !o.closest("[role=group]") && o.textContent !== "All doors")!;
    fireEvent.click(live);

    await waitFor(() => {
      const read = new URL(`http://x${stub.calls.filter((c) => c.path.includes("/doors/activity")).at(-1)!.path}`);
      expect(read.searchParams.get("door")).toBe(DOOR_ID);
      expect(read.searchParams.get("removed_door")).toBeNull();
    });
  });

  /**
   * <b>The server caps this list at fifty.</b>
   *
   * A picker that lists fifty removed doors and stops looks exactly like a club that has
   * removed fifty — and the door an admin is hunting for after an incident is, by
   * definition, the one that is not in it. Same class of falsehood as A6's count, one
   * control along: a page length presented as a total.
   */
  it("says the removed-door list is capped when it arrives full", async () => {
    open([doorLogFixture()], {
      removedDoors: Array.from({ length: 50 }, (_, i) => ({
        key: `gone-${i}`, name: `Gone ${i}`, gate_key: `gone-${i}`,
      })),
    });

    await picker("Door");
    expect(await screen.findByText(/50 most recently removed doors. There may be more/))
      .toBeInTheDocument();
  });

  it("says nothing about a cap on a list that is not full", async () => {
    open([doorLogFixture()], {
      removedDoors: Array.from({ length: 49 }, (_, i) => ({
        key: `gone-${i}`, name: `Gone ${i}`, gate_key: `gone-${i}`,
      })),
    });

    await picker("Door");
    openPicker("Door");
    await screen.findByRole("group", { name: "Removed doors" });
    expect(screen.queryByText(/There may be more/)).toBeNull();
  });

  /** A removed door has no page, so the page does not offer to send anybody to one. */
  it("does not link a removed door to a door page that is gone", async () => {
    open([], {
      removedDoors: [{ key: "side-door", name: "Side door", gate_key: "side-door" }],
    }, ["/admin/monitoring/doors/log?removed_door=side-door"]);

    await screen.findByText(/No scans at Side door/);
    expect(screen.queryByRole("link", { name: "Check it on Doors" })).toBeNull();
  });

  // --- A6: the count that read as a total ------------------------------------------

  /**
   * "50 scans, newest first" over a 70-row range. It was the length of one cursor page
   * printed as the answer to the question the page exists to answer, and it is the number an
   * admin repeats to a committee.
   */
  it("says how much of the range is on screen, not how many rows it has", async () => {
    open(manyRows(4), { pageSize: 2 });

    expect(await screen.findByText("Showing 2 of 4 scans in this range, newest first."))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toContain("2 scans, newest first");
  });

  it("says 'so far' rather than inventing a total the API did not send", async () => {
    const whoami = signIn({ isAdmin: true });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_credits: 0 } },
      { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
      {
        path: "/api/v1/admin/doors/activity",
        body: { items: [doorLogFixture()], next_cursor: null, retention_days: 90 },
      },
      { path: "/api/v1/admin/doors", status: 503, body: {} },
    ]);
    renderPage(<AdminDoorsLogPage />, { initialEntries: ["/admin/monitoring/doors/log"] });

    // R3-20: no total from the API AND no further cursor — so the page does know, and says
    // "all". "So far" is reserved for a list that genuinely has more behind it.
    expect(await screen.findByText("Showing all 1 scan in this range, newest first."))
      .toBeInTheDocument();
  });

  /**
   * <b>B1, one field along.</b> This page counts what IS a scan rather than trusting the
   * route. So if it filtered anything out of what arrived, the server's total counts rows
   * this page would not show — it is not a number about scans and is not stated.
   */
  it("drops the server's total when it filtered rows out of the page", async () => {
    open([
      doorLogFixture(),
      doorLogFixture({ at: ago(60), action: "device.updated", reason: null }),
    ]);

    expect(await screen.findByText("Showing all 1 scan in this range, newest first."))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toContain("of 2 scans");
  });

  // --- A7 / E-M5: the time a touch user can actually see ---------------------------

  /**
   * Every row printed "6m ago" and kept the exact time in a `title` — invisible on a phone,
   * invisible to a screen reader, invisible to touch. "What time did that happen" is the
   * committee's question and the screen would not answer it.
   */
  it("shows the club-local clock face on every row, with the age beneath it", async () => {
    open([doorLogFixture({ at: new Date(Date.now() - 300_000).toISOString() })]);

    const row = (await screen.findAllByRole("listitem"))[0];
    expect(row.textContent).toMatch(/\d{2}:\d{2}/);
    expect(row).toHaveTextContent("5m ago");
  });

  it("adds the day when the row is not today's", async () => {
    open([doorLogFixture({ at: new Date(Date.now() - 3 * 86_400_000).toISOString() })], {},
      ["/admin/monitoring/doors/log?range=7d"]);

    const row = (await screen.findAllByRole("listitem"))[0];
    // "Fri 18 Sep, 11:18" — B20: a weekday always carries its date, because the log ranges
    // over thirty days and four Fridays are in it.
    expect(row.textContent).toMatch(/\w{3} \d{1,2} \w{3,4}, \d{2}:\d{2}/);
    expect(row).toHaveTextContent("3d ago");
  });

  // --- C4: the buttons that dropped focus to <body> --------------------------------

  /**
   * <b>Every re-rendering button on this surface blurred to `&lt;body&gt;`.</b> The cause is
   * the same each time: a browser blurs a disabled element, so disabling the control an admin
   * has just pressed throws their place away. The nodes stay mounted and enabled; `aria-busy`
   * says what they are doing and the handler guards the double press.
   */
  it("keeps focus on Refresh while it is re-reading", async () => {
    open([doorLogFixture()]);

    const refresh = await screen.findByRole("button", { name: "Refresh" });
    refresh.focus();
    fireEvent.click(refresh);

    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("button", { name: /Refresh|Reading/ })).toHaveFocus();
  });

  it("keeps focus on Download CSV while it is preparing", async () => {
    open([doorLogFixture()]);

    const download = await screen.findByRole("button", { name: "Download CSV" });
    download.focus();
    fireEvent.click(download);

    expect(document.activeElement).not.toBe(document.body);
    await waitFor(() => expect(screen.getByRole("button", { name: "Download CSV" })).toHaveFocus());
  });

  /** And on the last page, where the button itself unmounts, focus lands on the notice. */
  it("never drops focus to the body when the last page exhausts the range", async () => {
    open(manyRows(3), { pageSize: 2 });

    await screen.findByText(/Showing 2 of 3/);
    const older = screen.getByRole("button", { name: "Load older scans" });
    older.focus();
    fireEvent.click(older);

    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
    expect(document.activeElement).not.toBe(document.body);
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

/**
 * <b>A-C2 / R3-13 — the stale door link, and the three lies it told at once.</b>
 *
 * <p>
 * A bookmark, an emailed link or a browser-history entry pointing at a door becomes this the
 * day that board is replaced. The picker showed "All doors", the page said "No scans at any
 * door in the last 24 hours", and the CSV exported nought rows under the ordinary filename.
 * The middle one is the sentence a committee reads as "the doors recorded nothing that
 * night", and the records were there the whole time.
 * </p>
 */
describe("the club door log, filtered to a door that is gone", () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  const GONE = "11111111-2222-3333-4444-555555555555";

  const openGone = (opts: { refuses: boolean }) => {
    const server = doorsServer([doorFixture()], { activity: [] });
    const whoami = signIn({ isAdmin: true });
    const routes = [
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_credits: 0 } },
      { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
      ...server.routes,
    ];
    if (opts.refuses) {
      // WIRE-R3 §4, as the backend lane is landing it.
      routes.push({
        path: "/api/v1/admin/doors/activity",
        status: 400,
        body: { error: "door_not_found" },
      } as (typeof routes)[number]);
    }
    const stub = stubFetch(routes);
    renderPage(<AdminDoorsLogPage />, { initialEntries: [`/admin/monitoring/doors/log?door=${GONE}`] });
    return { stub };
  };

  it("says the door is gone rather than that nothing happened at any door", async () => {
    openGone({ refuses: true });

    expect(await screen.findByText(/no longer on the club's list/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("No scans at any door");
    // The half a committee needs: the records were not destroyed with the board.
    expect(document.body.textContent).toContain("past scans are kept");
  });

  /**
   * <b>And against the backend that is deployed today.</b> An older API answers 200 with an
   * empty page for an unknown id — which is the exact shape that produced "No scans at any
   * door". A fix that only works once the backend lands is a page that is wrong for as long
   * as the two lanes are out of step.
   */
  it("says the same thing when the API answers 200 and nothing", async () => {
    openGone({ refuses: false });

    expect(await screen.findByText(/no longer on the club's list/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("No scans at any door");
  });

  it("does not offer an export that would write a nought-row file under the usual name", async () => {
    openGone({ refuses: true });

    await screen.findByText(/no longer on the club's list/);
    expect(screen.queryByRole("button", { name: /Download CSV/ })).toBeNull();
    expect(document.body.textContent).toContain("nothing to export");
  });

  it("offers the way out, and taking it shows the club's doors again", async () => {
    openGone({ refuses: true });

    fireEvent.click(await screen.findByRole("button", { name: "Show all doors" }));

    await waitFor(() => {
      expect(document.body.textContent).not.toContain("no longer on the club's list");
    });
  });
});

/**
 * <b>E6 / R3-19 — the heading was a constant over a filtered page.</b>
 *
 * It is the line a screenshot of this page is read as afterwards, and an admin who filtered
 * to one door's refusals and sent it to a committee sent a picture captioned "All scans, all
 * doors".
 */
describe("the club door log's heading", () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  const openAt = (entry: string) => {
    const server = doorsServer([doorFixture()], { activity: [doorLogFixture()] });
    const whoami = signIn({ isAdmin: true });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_credits: 0 } },
      { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
      ...server.routes,
    ]);
    renderPage(<AdminDoorsLogPage />, { initialEntries: [entry] });
  };

  it("still reads All scans, all doors when nothing is narrowed", async () => {
    openAt("/admin/monitoring/doors/log");

    expect(await screen.findByRole("heading", { level: 1 }))
      .toHaveTextContent("All scans, all doors");
  });

  it("names the door, the outcome and the range it is actually showing", async () => {
    openAt(`/admin/monitoring/doors/log?door=${DOOR_ID}&outcome=refused&range=yesterday`);

    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Refused scans, at Side door — yesterday");
    expect(heading.textContent).not.toContain("all doors");
  });
});

/**
 * <b>A-H2 / R3-14 — the export failed and the page said nothing at all.</b>
 *
 * <p>
 * Offline, or on a 500, the button went back to "Download CSV" and the screen was identical
 * before and after. The handler does push a toast — but a toast floats above the content and
 * times out, and on the one action whose whole output is a file that either exists or does
 * not, a message that has already gone is the same as no message. The reviewer pressed it
 * offline and could not tell the failure from a browser that had saved the file silently.
 * </p>
 */
describe("the club door log's export, when it fails", () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.unstubAllGlobals(); signOut(); });

  it("says so on the page, and says that no file was written", async () => {
    const server = doorsServer([doorFixture()], { activity: [doorLogFixture()] });
    const whoami = signIn({ isAdmin: true });
    stubFetch([
      { path: "/api/v1/whoami", body: whoami },
      { path: "/api/v1/wallet", body: { balance_credits: 0 } },
      { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
      // BEFORE the server's own CSV route: the stub sorts by prefix LENGTH and these two are
      // the same path, so declaration order decides and the first one wins.
      { path: "/api/v1/admin/doors/activity.csv", status: 500, body: { error: "boom" } },
      ...server.routes,
    ]);
    renderPage(<AdminDoorsLogPage />, { initialEntries: ["/admin/monitoring/doors/log"] });

    fireEvent.click(await screen.findByRole("button", { name: /Download CSV/ }));

    // TWO of them, and that is the assertion: the toast (which floats and times out) AND a
    // sentence in the page's own flow beside the button, which is what is still there when an
    // admin looks for the file. The page one is the `role="alert"` inside `#main-content`;
    // finding exactly one there is what proves the toast is not being counted as the fix.
    await screen.findAllByText(/No file was downloaded/);
    const onPage = screen.getByRole("button", { name: /Download CSV/ })
      .parentElement!.querySelector('[role="alert"]')!;
    expect(onPage.textContent).toContain("No file was downloaded");
    expect(onPage.textContent).toContain("nothing at the doors has changed");
  });
});
