import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminSchedulesPage } from "./AdminSchedules";
import { refuse, renderPage, signIn, signOut, stubFetch } from "../test/harness";
import {
  COURT_IDS, conflictFixture, editorPrerequisiteRoutes, previewFixture, scheduleRowFixture,
  sessionRoutes,
} from "../test/scheduleFixtures";
import { forgetClubZone } from "../lib/clubZone";

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

beforeEach(() => {
  signIn({ isAdmin: true });
  forgetClubZone();
});

afterEach(() => {
  signOut();
  vi.unstubAllGlobals();
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

  it("teaches the feature when the club genuinely has none", async () => {
    stubFetch([...sessionRoutes(), { path: SCHEDULES, body: { schedules: [] } }]);
    renderPage(<AdminSchedulesPage />);

    expect(await screen.findByText("No repeating bookings yet.")).toBeInTheDocument();
    expect(screen.getByText(/without booking 360 slots by hand/)).toBeInTheDocument();
  });

  it("never says the club has none when what failed was the reading", async () => {
    // The whole reason StateBlock puts failed before empty. This page's empty state is a
    // teaching sentence, so rendering it over a failed read invites an admin to create a
    // second league night on top of the one that already exists.
    stubFetch([...sessionRoutes(), { path: SCHEDULES, status: 500, body: { error: "server_error" } }]);
    renderPage(<AdminSchedulesPage />);

    await screen.findByText(/That does not mean the club has none\./);
    expect(screen.queryByText("No repeating bookings yet.")).not.toBeInTheDocument();
    // And no retry: `isDeploymentFault` treats a 5xx as something the reader cannot act on,
    // so offering "Try again" here would be inviting an admin to press a button forever.
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
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
   * `fireEvent.change` for the date and time fields, `userEvent` for everything else.
   *
   * Not a shortcut: `userEvent.type` sends one keystroke at a time, and a CONTROLLED
   * `<input type="date">` in jsdom rejects every intermediate value ("2", "20", "202"…) as
   * invalid, so the field keeps whatever it started with and the test asserts against a
   * sentence nobody typed. It cost a probe to find, and it is the reason this helper exists
   * rather than the three lines being inlined per case.
   */
  function setDateOrTime(label: string, value: string) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }

  async function fillTheSentence() {
    await userEvent.click(screen.getByRole("button", { name: /^Courts: / }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Court 1" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Court 2" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Court 3" }));
    await userEvent.type(screen.getByLabelText("What members see on the grid"), "League night");
    await userEvent.type(screen.getByLabelText("A name for this repeating booking, for admins"), "Tuesday league");
    setDateOrTime("First date", "2026-10-06");
    setDateOrTime("Last date (leave empty for no end)", "2026-12-15");
  }

  it("says what the sentence would do, in slots, as it is typed", async () => {
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes(),
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText("No repeating bookings yet.");
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
    await screen.findByText("No repeating bookings yet.");
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
    await screen.findByText("No repeating bookings yet.");
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

  it("takes the Save away again the moment the sentence changes", async () => {
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes(),
      { method: "POST", path: `${SCHEDULES}/preview`, body: previewFixture() },
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText("No repeating bookings yet.");
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });
    await fillTheSentence();
    await userEvent.click(screen.getByRole("button", { name: "Check 11 Tuesdays" }));
    await screen.findByRole("button", { name: "Create the hold" });

    // One court fewer. The check that came back clear was about a different sentence.
    await userEvent.click(screen.getByRole("checkbox", { name: "Court 3" }));

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
    await screen.findByText("No repeating bookings yet.");
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
              member_name: "Jason Fourie", would_refund_credits: 24,
            }),
          ],
        }),
      },
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText("No repeating bookings yet.");
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });
    await fillTheSentence();
    await userEvent.click(screen.getByRole("button", { name: "Check 11 Tuesdays" }));

    expect(await screen.findByText(/2 bookings are in the way\./)).toBeInTheDocument();
    expect(screen.getByText(/Nothing has changed yet\./)).toBeInTheDocument();
    expect(screen.getByText("36.00 cr would go back to Thandi Mokoena.")).toBeInTheDocument();
    expect(screen.getByText("24.00 cr would go back to Jason Fourie.")).toBeInTheDocument();
    // D2 §11.4: there is no force flag, so there is no control that creates over these.
    expect(screen.queryByRole("button", { name: "Create the hold" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancel 2 bookings and refund 60\.00 cr in full/ }))
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
            conflictFixture({ booking_id: "b-2", member_name: "Jason Fourie", would_refund_credits: undefined }),
          ],
        }),
      },
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText("No repeating bookings yet.");
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });
    await fillTheSentence();
    await userEvent.click(screen.getByRole("button", { name: "Check 11 Tuesdays" }));

    expect(await screen.findByText("What would go back to Jason Fourie isn't known yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancel 2 bookings and refund them in full/ })).toBeInTheDocument();
    expect(screen.queryByText(/refund 36\.00 cr in full/)).not.toBeInTheDocument();
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
          ? { refunded_credits: 36, penalty_credits: 0 }
          : refuse(404, { error: "not_found" })),
      },
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText("No repeating bookings yet.");
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });
    await fillTheSentence();
    await userEvent.click(screen.getByRole("button", { name: "Check 11 Tuesdays" }));
    await screen.findByText(/1 booking is in the way\./);

    // The reason is required: it is what the member is told and what the record keeps.
    const clear = screen.getByRole("button", { name: /Cancel 1 booking and refund 36\.00 cr in full/ });
    expect(clear).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Reason/), "Courts held for league");
    await userEvent.click(clear);
    // Armed: the consequence is a block of page text ABOVE the pair of buttons, so it is read
    // before the second press rather than being the label of the control that acts.
    expect((await screen.findAllByText(/36\.00 cr goes back in full/)).length).toBeGreaterThan(0);
    // The way out is named for what it KEEPS, never for the destructive verb: "Keep them —
    // 1 member booking", not "Keep them — Cancel 1 booking".
    expect(screen.getByRole("button", { name: "Keep them — 1 member booking" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Cancel 1 booking and refund 36\.00 cr in full — / }));

    const results = await screen.findByRole("region", { name: "What was cancelled" });
    expect(within(results).getByRole("status")).toHaveTextContent("1 of 1 done");
    expect(within(results).getByText(/36\.00 cr went back in full\./)).toBeInTheDocument();

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
    await screen.findByText("No repeating bookings yet.");
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
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes(),
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText("No repeating bookings yet.");
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });
    await fillTheSentence();

    setDateOrTime("Start time", "18:05");

    expect(await screen.findByText(
      "This club books in 15-minute slots, so the start and the end both have to land on a 15-minute mark.",
    )).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Check / })).toBeDisabled();
  });

  it("is operable by keyboard alone, every field of it (D3 §12, story P6)", async () => {
    // Native controls throughout, which is why this passes with no key handlers of our own.
    // The assertion is the whole point of that decision: a popover-based sentence needs a
    // focus trap, an escape handler and a restore path, and `Modal` in this repo has none of
    // the three (D3-B05). Tab order here IS document order, so the sentence reads in the
    // order it is spoken.
    stubFetch([
      ...sessionRoutes(),
      { path: SCHEDULES, body: { schedules: [] } },
      ...editorPrerequisiteRoutes(),
    ]);
    renderPage(<AdminSchedulesPage />);
    await screen.findByText("No repeating bookings yet.");
    await openEditor();
    await screen.findByRole("heading", { name: "A new repeating booking" });

    const order = [
      screen.getByRole("button", { name: /^Courts: / }),
      screen.getByRole("button", { name: /^Days of the week: / }),
      screen.getByLabelText("Start time"),
      screen.getByLabelText("End time"),
      screen.getByLabelText("What members see on the grid"),
      screen.getByLabelText("First date"),
      screen.getByLabelText("Last date (leave empty for no end)"),
      screen.getByLabelText("Repeat every how many weeks"),
      screen.getByLabelText("A name for this repeating booking, for admins"),
    ];
    for (const field of order) {
      await userEvent.tab();
      expect(document.activeElement).toBe(field);
    }

    // And the one field that is not a native input opens from the keyboard and reports its
    // state through `aria-expanded`, which is what a screen reader reads.
    const courts = screen.getByRole("button", { name: /^Courts: / });
    courts.focus();
    expect(courts).toHaveAttribute("aria-expanded", "false");
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: /^Courts: / })).toHaveAttribute("aria-expanded", "true");
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: "Court 1" }));
    await userEvent.keyboard(" ");
    expect(screen.getByRole("checkbox", { name: "Court 1" })).toBeChecked();
    // The inactive court is not offered: a court nobody may book one slot on is not a court
    // that may be held every Tuesday for a season.
    expect(screen.queryByRole("checkbox", { name: "Court 9" })).not.toBeInTheDocument();
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
    await screen.findByText("No repeating bookings yet.");
    await openEditor();

    expect(await screen.findByText(/Nothing can be held until they can be read\./)).toBeInTheDocument();
    expect(screen.queryByLabelText("Start time")).not.toBeInTheDocument();
  });
});
