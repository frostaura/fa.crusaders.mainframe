import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminSchedulesPage } from "./AdminSchedules";
import { refuse, renderPage, signIn, signOut, stubFetch } from "../test/harness";
import {
  COURT_IDS, SCHEDULE_ID, conflictFixture, editorPrerequisiteRoutes, previewFixture,
  scheduleCreateResponse, scheduleRowFixture, sessionRoutes,
} from "../test/scheduleFixtures";
import { forgetClubZone } from "../lib/clubZone";
import { LIST_EMPTY_ENDED_POINTER, LIST_EMPTY_TITLE } from "../lib/scheduleCopy";
import { serverRecordFields } from "../test/serverContract";
// The date picker's calendar is a lazy chunk (P10). Loaded here, once, so opening a picker in a
// test resolves from the module cache instead of racing a cold transform under a loaded runner.
import "@/components/ui/date-picker-calendar";

/**
 * A longer per-test timeout than the 5-second default, for this file only. Each case opens
 * the editor, ticks courts and walks the day picker month by month in jsdom — 1-2 s on a quiet
 * machine,
 * past 5 s when the suite shares the machine with a parallel backend run or another build
 * (measured 2026-09-28: seven AdminSchedules cases timed out that way with nothing wrong).
 * The assertions are untouched; only the time allowed to render them is.
 */
vi.setConfig({ testTimeout: 20_000 });

/**
 * Repeating bookings — the list, and the create flow up to and including the clash check.
 *
 * <p>
 * <b>The behaviour this file exists to pin is the ordering of two controls.</b> Create must
 * not be reachable before a check has come back clear, and it must stop being reachable the
 * moment the sentence changes underneath one. Everything else on this page is ordinary; that
 * one rule is what makes the surface worth building, and it is the rule a later refactor is
 * most likely to break by "simplifying" the state machine into a boolean.
 * </p>
 */

const SCHEDULES = "/api/v1/admin/schedules";

/**
 * The clock the fixtures were written against. The create flow picks FIXED dates in October
 * 2026 by walking the day picker forward from today, and the picker refuses past days — so on
 * the real clock this file went red for good once 2026-10-06 was behind us. Only `Date` is
 * faked: user-event under fake timers deadlocks here (memory/gotchas-frontend.md).
 */
const PINNED_NOW = new Date("2026-09-29T08:00:00+02:00");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: PINNED_NOW });
  signIn({ isAdmin: true });
  forgetClubZone();
});

afterEach(() => {
  signOut();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the list", () => {
  it("shows what each repeating booking holds, as a sentence", async () => {
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [scheduleRowFixture({ next_occurrence: "2026-10-06T16:00:00.000Z" })] } },
    ]);
    renderPage(<AdminSchedulesPage />);

    expect(await screen.findByRole("heading", { name: "Tuesday league" })).toBeInTheDocument();
    expect(screen.getByText(
      "Holds Courts 1, 2 and 3 on Tuesdays from 18:00 to 21:00, called “League night”, "
      + "from Tue 6 Oct until Tue 15 Dec.",
    )).toBeInTheDocument();
    // The link is named by what it opens. A column of links all reading "Open" is nothing at
    // all to somebody tabbing down it.
    expect(screen.getByRole("link", { name: "Open Tuesday league" })).toHaveAttribute(
      "href", "/admin/schedules/50000000-0000-0000-0000-000000000001",
    );
  });

  /** R5 A5-4: the list described a series by its LATEST rule — "Sundays" while it still held Saturdays. */
  it("says what holds now, and the change still to come", async () => {
    stubFetch([
      ...sessionRoutes(),
      {
        path: SCHEDULES,
        body: {
          schedules: [scheduleRowFixture({
            days: ["sun"], start: "18:00", end: "20:00", start_date: "2026-10-03", end_date: null,
            rules: [
              { from: "2026-10-03", until: "2026-11-01", days: ["sat"], start: "18:00", end: "20:00", interval_weeks: 1, in_force: true },
              { from: "2026-11-01", until: null, days: ["sun"], start: "18:00", end: "20:00", interval_weeks: 1, in_force: false },
            ],
          })],
        },
      },
    ]);
    renderPage(<AdminSchedulesPage />);
    expect(await screen.findByText(/^Holds Courts 1, 2 and 3 on Saturdays from 18:00 to 20:00/)).toBeInTheDocument();
    expect(screen.getByText("From Sun 1 Nov it holds Sundays, 18:00 to 20:00, instead.")).toBeInTheDocument();
  });

  it("teaches the feature when the club genuinely has none", async () => {
    stubFetch([...sessionRoutes(), { path: SCHEDULES, body: { schedules: [] } }]);
    renderPage(<AdminSchedulesPage />);

    expect(await screen.findByText(LIST_EMPTY_TITLE)).toBeInTheDocument();
    expect(screen.getByText(/without booking 360 slots by hand/)).toBeInTheDocument();
    // R3 A-6: "Running now" being empty says nothing about ended ones, and points at them.
    expect(screen.getByText(new RegExp(LIST_EMPTY_ENDED_POINTER))).toBeInTheDocument();
  });

  it("never says the club has none when what failed was the reading", async () => {
    // The whole reason StateBlock puts failed before empty. This page's empty state is a
    // teaching sentence, so rendering it over a failed read invites an admin to create a
    // second league night on top of the one that already exists.
    stubFetch([...sessionRoutes(), { path: SCHEDULES, status: 500, body: { error: "server_error" } }]);
    renderPage(<AdminSchedulesPage />);

    await screen.findByText(/That does not mean the club has none\./);
    expect(screen.queryByText(LIST_EMPTY_TITLE)).not.toBeInTheDocument();
    // A plain 500 is transient (review round 1, F4.4): the sentence says "try again shortly",
    // so the button to do it is there. And the sentence has its verb (F3.19).
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByText(/^Couldn't read the club's repeating bookings/)).toBeInTheDocument();
  });

  it("does not claim a series has finished because the next date is missing", async () => {
    // `next_occurrence` is absent on an API that has not shipped the field. Absent is not
    // "there are no more" — the page would be announcing an ending it invented.
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [scheduleRowFixture({ next_occurrence: undefined })] } },
    ]);
    renderPage(<AdminSchedulesPage />);

    expect(await screen.findByText("The next date hasn't been worked out yet.")).toBeInTheDocument();
    expect(screen.queryByText(/no more dates/)).not.toBeInTheDocument();
  });

  it("asks the server for the status the admin chose", async () => {
    const stub = stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [scheduleRowFixture({ status: "ended" })] } },
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByRole("heading", { name: "Tuesday league" });

    // Three choices, always visible (R7): a segmented control rather than a select.
    await userEvent.click(screen.getByRole("radio", { name: "Ended" }));

    await waitFor(() => {
      expect(stub.calls.some((c) => c.path.includes("status=ended"))).toBe(true);
    });
  });
});

describe("creating one", () => {
  function openEditor() {
    return userEvent.click(screen.getByRole("button", { name: "Create a repeating booking" }));
  }

  /**
   * The sentence's date fields are the club-day DatePicker (P3, R7): open it, walk forward a
   * month at a time until the day is on screen, tap it. The picker closes itself on a pick.
   */
  async function pickDay(name: RegExp, day: string) {
    await userEvent.click(screen.getByRole("button", { name }));
    // The calendar is its own lazily loaded chunk (P10): let it arrive before walking it.
    await screen.findByRole("button", { name: /next month/i });
    for (let month = 0; month < 36; month++) {
      const button = document.querySelector<HTMLButtonElement>(`button[data-day="${day}"]`);
      if (button) {
        await userEvent.click(button);
        return;
      }
      await userEvent.click(screen.getByRole("button", { name: /next month/i }));
    }
    throw new Error(`no ${day} within three years of the picker's month`);
  }

  /** A TimeSelect: open the Radix list, choose the option. Only slice-aligned times exist. */
  async function pickTime(name: string, time: string) {
    fireEvent.pointerDown(screen.getByRole("combobox", { name }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: time }));
  }

  /** One of the two set-valued fields: open its popover, toggle the options, close it. */
  async function toggleChoices(trigger: RegExp, options: string[]) {
    await userEvent.click(screen.getByRole("button", { name: trigger }));
    for (const option of options) await userEvent.click(await screen.findByRole("checkbox", { name: option }));
    await userEvent.keyboard("{Escape}");
  }

  async function fillTheSentence() {
    await toggleChoices(/^Courts: /, ["Court 1", "Court 2", "Court 3"]);
    // Set, not typed: nothing here is about keystrokes, and user-event re-renders this whole
    // form once per character (see memory/gotchas-frontend.md on its typing path under jsdom).
    fireEvent.change(screen.getByLabelText("What members see on the grid"), { target: { value: "League night" } });
    fireEvent.change(screen.getByLabelText("A name for this repeating booking, for admins"), { target: { value: "Tuesday league" } });
    await pickDay(/^First date/, "2026-10-06");
    await pickDay(/^Last date/, "2026-12-15");
  }

  it("says what the sentence would do, in slots, as it is typed", async () => {
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes(),
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText(LIST_EMPTY_TITLE);
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });

    await fillTheSentence();

    // 11 Tuesdays × 3 courts × 12 quarter-hours.
    expect(await screen.findByText(
      "That is 11 Tuesdays. 3 courts × 12 slots = 396 slots held. "
      + "Members will see “League night” and cannot book them.",
    )).toBeInTheDocument();
  });

  it("counts in the club's OWN slice, not in fifteens", async () => {
    // Vary the fixture, not the code. On a half-hour club the same sentence holds half as
    // many slots, and the consequence line is the only thing that says so.
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes({ slice_minutes: 30 }),
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText(LIST_EMPTY_TITLE);
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });
    await fillTheSentence();

    expect(await screen.findByText(/3 courts × 6 slots = 198 slots held/)).toBeInTheDocument();
  });

  it("offers no Save until the check has run", async () => {
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes(),
      { method: "POST", path: `${SCHEDULES}/preview`, body: previewFixture() },
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText(LIST_EMPTY_TITLE);
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });
    await fillTheSentence();

    // Before the check: there is no Create button anywhere in the document.
    expect(screen.queryByRole("button", { name: "Create the hold" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Check 11 Tuesdays" }));

    expect(await screen.findByText(
      "Nothing is in the way. All 396 slots are free on all 11 Tuesdays.",
    )).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create the hold" })).toBeInTheDocument();
  });

  it("names what it created from the server's `{ schedule, rows_created }` reply", async () => {
    // Review round 2 (F3-1): the create answers an envelope, the page read the row's name off
    // its top level, and the notice said "“undefined” was created. Open undefined".
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes(),
      { method: "POST", path: `${SCHEDULES}/preview`, body: previewFixture() },
      { method: "POST", path: SCHEDULES, body: scheduleCreateResponse(scheduleRowFixture()) },
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText(LIST_EMPTY_TITLE);
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });
    await fillTheSentence();
    await userEvent.click(screen.getByRole("button", { name: "Check 11 Tuesdays" }));
    await userEvent.click(await screen.findByRole("button", { name: "Create the hold" }));

    expect(await screen.findByText(/“Tuesday league” was created\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Tuesday league to see its dates" }))
      .toHaveAttribute("href", `/admin/schedules/${SCHEDULE_ID}`);
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });

  it("sends the sentence under the field names the server's ScheduleRequest binds", async () => {
    // Review round 1 (F3.1): the screen sent `courtIds`, the server reads `courts`, and no
    // repeating booking could be created. The names are read from the C# record, not restated.
    const stub = stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes(),
      { method: "POST", path: `${SCHEDULES}/preview`, body: previewFixture() },
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText(LIST_EMPTY_TITLE);
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });
    await fillTheSentence();
    await userEvent.click(screen.getByRole("button", { name: "Check 11 Tuesdays" }));
    await screen.findByRole("button", { name: "Create the hold" });

    const server = serverRecordFields("Endpoints/ScheduleRequestParsing.cs", "ScheduleRequest");
    expect(server).toContain("courts");
    const sent = stub.calls.find((c) => c.method === "POST" && c.path === `${SCHEDULES}/preview`);
    const body = sent?.body as Record<string, unknown>;
    expect(Object.keys(body).filter((k) => !server.includes(k))).toEqual([]);
    expect([...(body.courts as string[])].sort()).toEqual([COURT_IDS.one, COURT_IDS.two, COURT_IDS.three].sort());
  });

  it("takes the Save away again the moment the sentence changes", async () => {
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes(),
      { method: "POST", path: `${SCHEDULES}/preview`, body: previewFixture() },
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText(LIST_EMPTY_TITLE);
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });
    await fillTheSentence();
    await userEvent.click(screen.getByRole("button", { name: "Check 11 Tuesdays" }));
    await screen.findByRole("button", { name: "Create the hold" });

    // One court fewer. The check that came back clear was about a different sentence.
    await toggleChoices(/^Courts: /, ["Court 3"]);

    expect(await screen.findByText(
      "The sentence changed after that check, so it no longer says what would happen. Check again.",
    )).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create the hold" })).not.toBeInTheDocument();
  });

  it("never offers a Save after a check that did not finish", async () => {
    // A check that failed is not evidence that nothing is in the way, and this is the one
    // state where a screen is most tempted to shrug and let the server decide.
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes(),
      { method: "POST", path: `${SCHEDULES}/preview`, status: 500, body: { error: "server_error" } },
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText(LIST_EMPTY_TITLE);
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });
    await fillTheSentence();
    await userEvent.click(screen.getByRole("button", { name: "Check 11 Tuesdays" }));

    expect(await screen.findByText(/The check didn't finish, so nothing was created\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create the hold" })).not.toBeInTheDocument();
  });

  it("lists what is in the way and offers no way to create over it", async () => {
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes(),
      {
        method: "POST",
        path: `${SCHEDULES}/preview`,
        body: previewFixture({
          conflicts: [
            conflictFixture(),
            conflictFixture({
              occurrence_date: "2026-10-20", court_id: COURT_IDS.three, court_name: "Court 3",
              starts_at: "2026-10-20T17:00:00.000Z", booking_id: "b-2",
              member_name: "Jason Fourie", would_refund_minutes: 24,
            }),
          ],
        }),
      },
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText(LIST_EMPTY_TITLE);
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });
    await fillTheSentence();
    await userEvent.click(screen.getByRole("button", { name: "Check 11 Tuesdays" }));

    expect(await screen.findByText(/2 bookings are in the way\./)).toBeInTheDocument();
    expect(screen.getByText(/Nothing has changed yet\./)).toBeInTheDocument();
    expect(screen.getByText("36 minutes would go back to Thandi Mokoena.")).toBeInTheDocument();
    expect(screen.getByText("24 minutes would go back to Jason Fourie.")).toBeInTheDocument();
    // D2 §11.4: there is no force flag, so there is no control that creates over these.
    expect(screen.queryByRole("button", { name: "Create the hold" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancel 2 bookings and refund 1 hour in full/ }))
      .toBeInTheDocument();
  });

  it("does not put a figure on the button when one refund quote is missing", async () => {
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes(),
      {
        method: "POST",
        path: `${SCHEDULES}/preview`,
        body: previewFixture({
          conflicts: [
            conflictFixture(),
            conflictFixture({ booking_id: "b-2", member_name: "Jason Fourie", would_refund_minutes: undefined }),
          ],
        }),
      },
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText(LIST_EMPTY_TITLE);
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });
    await fillTheSentence();
    await userEvent.click(screen.getByRole("button", { name: "Check 11 Tuesdays" }));

    expect(await screen.findByText("What would go back to Jason Fourie isn't known yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancel 2 bookings and refund them in full/ })).toBeInTheDocument();
    expect(screen.queryByText(/refund 36 minutes in full/)).not.toBeInTheDocument();
  });

  it("cancels the bookings in the way, in full, and says what happened to each", async () => {
    const stub = stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes(),
      { method: "POST", path: `${SCHEDULES}/preview`, body: previewFixture({ conflicts: [conflictFixture()] }) },
      {
        method: "POST",
        path: "/api/v1/admin/bookings/",
        respond: (req) => (req.path.endsWith("/cancel")
          ? { refunded_minutes: 36, penalty_minutes: 0 }
          : refuse(404, { error: "not_found" })),
      },
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText(LIST_EMPTY_TITLE);
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });
    await fillTheSentence();
    await userEvent.click(screen.getByRole("button", { name: "Check 11 Tuesdays" }));
    await screen.findByText(/1 booking is in the way\./);

    // The reason is required: it is what the member is told and what the record keeps.
    const clear = screen.getByRole("button", { name: /Cancel 1 booking and refund 36 minutes in full/ });
    expect(clear).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Reason/), "Courts held for league");
    await userEvent.click(clear);
    // Confirmed in a dialog (P3): the consequence is its description, read before the press.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/36 minutes goes back in full/);
    // The way out is named for what it KEEPS, never for the destructive verb.
    expect(within(dialog).getByRole("button", { name: "Keep them" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /^Cancel 1 booking and refund 36 minutes in full/ }));

    const results = await screen.findByRole("region", { name: "What was cancelled" });
    expect(within(results).getByRole("status")).toHaveTextContent("1 of 1 done");
    expect(within(results).getByText(/36 minutes went back in full\./)).toBeInTheDocument();

    // The penalty is waived: the club moved, not the member.
    const cancelCall = stub.calls.find((c) => c.path.endsWith("/cancel"));
    expect(cancelCall?.body).toMatchObject({ waivePenalty: true, waiveReason: "Courts held for league" });

    // And the check above is now stale, because the club has just changed.
    expect(screen.queryByRole("button", { name: "Create the hold" })).not.toBeInTheDocument();
  });

  it("handles the world moving between the check and the press", async () => {
    // POST /schedules re-runs the same dry run. A 409 here is not "that failed" — it is
    // "somebody booked while you were reading, and nothing has been created".
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes(),
      { method: "POST", path: `${SCHEDULES}/preview`, body: previewFixture() },
      {
        method: "POST",
        path: SCHEDULES,
        status: 409,
        body: { error: "schedule_conflicts", occurrences: 11, conflicts: [conflictFixture()] },
      },
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText(LIST_EMPTY_TITLE);
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });
    await fillTheSentence();
    await userEvent.click(screen.getByRole("button", { name: "Check 11 Tuesdays" }));
    await userEvent.click(await screen.findByRole("button", { name: "Create the hold" }));

    expect(await screen.findByText(
      /Something was booked in the way while you were reading\. Nothing has been created/,
    )).toBeInTheDocument();
    expect(screen.getByText(/1 booking is in the way\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create the hold" })).not.toBeInTheDocument();
  });

  it("refuses to check a sentence the server would certainly refuse, and says why", async () => {
    // The misaligned-time case this used to pin ("18:05" on a 15-minute club) cannot be entered
    // any more: the time fields offer slice-aligned options only (P3, R7 — never free-typed).
    // An end before the start is still choosable, and still refused before the server sees it.
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes(),
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText(LIST_EMPTY_TITLE);
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });
    await fillTheSentence();

    await pickTime("End time", "17:00");

    expect(await screen.findByText("The end time has to be after the start time, on the same day.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Check / })).toBeDisabled();
  });

  it("offers only the times the club can book", async () => {
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes({ slice_minutes: 30 }),
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText(LIST_EMPTY_TITLE);
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });

    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Start time" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    // 06:00 → 21:30 in half hours: the club's day (fixture 360 → 1320) less one slice.
    expect(options[0]).toBe("06:00");
    expect(options.at(-1)).toBe("21:30");
    expect(options.every((t) => /:(00|30)$/.test(t ?? ""))).toBe(true);
  });

  it("names the Courts and Days popovers, which Radix makes dialogs (F3.22)", async () => {
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes(),
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText(LIST_EMPTY_TITLE);
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });
    await userEvent.click(screen.getByRole("button", { name: /^Courts: / }));
    expect(await screen.findByRole("dialog", { name: "Courts" })).toBeInTheDocument();
  });

  it("is operable by keyboard alone, every field of it (D3 §12, story P6)", async () => {
    // Every field is a design-system control (P3, R7) with its own name, and tab order IS
    // document order, so the sentence reads in the order it is spoken.
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes(),
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText(LIST_EMPTY_TITLE);
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });

    const order = [
      screen.getByRole("button", { name: /^Courts: / }),
      screen.getByRole("button", { name: /^Days of the week: / }),
      screen.getByRole("combobox", { name: "Start time" }),
      screen.getByRole("combobox", { name: "End time" }),
      screen.getByLabelText("What members see on the grid"),
      screen.getByRole("button", { name: /^First date/ }),
      screen.getByRole("button", { name: /^Last date/ }),
      screen.getByRole("combobox", { name: "Repeat every how many weeks" }),
      screen.getByLabelText("A name for this repeating booking, for admins"),
    ];
    for (const field of order) {
      await userEvent.tab();
      expect(document.activeElement).toBe(field);
    }

    // A set-valued field opens from the keyboard, reports its state through `aria-expanded`,
    // and puts focus on its first checkbox (it is a popover now — P3 — so focus moves INTO it
    // rather than the reader tabbing forward to reach it). Escape returns focus to the trigger.
    const courts = screen.getByRole("button", { name: /^Courts: / });
    courts.focus();
    expect(courts).toHaveAttribute("aria-expanded", "false");
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: /^Courts: / })).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: "Court 1" })));
    await userEvent.keyboard(" ");
    expect(screen.getByRole("checkbox", { name: "Court 1" })).toBeChecked();
    // The inactive court is not offered: a court nobody may book one slot on is not a court
    // that may be held every Tuesday for a season.
    expect(screen.queryByRole("checkbox", { name: "Court 9" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Courts: / })));
  });

  it("does not let the sentence be typed at all until the courts are known", async () => {
    // Unknown is never false: with the court read down, the editor declines to judge rather
    // than telling an admin their courts are invalid out of its own gap.
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      { path: "/api/v1/admin/courts/", status: 500, body: { error: "server_error" } },
      { path: "/api/v1/admin/settings/", status: 500, body: { error: "server_error" } },
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText(LIST_EMPTY_TITLE);
    await openEditor();

    expect(await screen.findByText(/Nothing can be held until they can be read\./)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Start time" })).not.toBeInTheDocument();
  });
});
