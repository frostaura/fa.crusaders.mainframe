import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminScheduleDetailPage } from "./AdminScheduleDetail";
import { renderPage, signIn, signOut, stubFetch, type StubRoute } from "../test/harness";
import {
  SCHEDULE_ID, changeRowFixture, occurrenceFixture, scheduleRowFixture, sessionRoutes,
} from "../test/scheduleFixtures";
import { forgetClubZone } from "../lib/clubZone";

/**
 * A longer per-test timeout than the 5-second default, for this file only. Each case drives
 * the schedule editor and its day picker in jsdom — 1-2 s on a quiet machine,
 * past 5 s when the suite shares the machine with a parallel backend run or another build
 * (measured 2026-09-28: seven AdminSchedules cases timed out that way with nothing wrong).
 * The assertions are untouched; only the time allowed to render them is.
 */
vi.setConfig({ testTimeout: 20_000 });

/**
 * One repeating booking: what it holds, what has been changed about it, and the two ways to
 * change it.
 *
 * <p>
 * <b>Three rules are pinned here and nothing else on the page matters as much.</b> There is no
 * delete — a schedule that ran is history and ENDING it is the operation (D2 §11.5). The past
 * is immutable and says so in a sentence rather than in a code. And an edit always asks which
 * dates, stating the third fact — that the ones already played never change — whether or not
 * anybody asked.
 * </p>
 */

const BASE = `/api/v1/admin/schedules/${SCHEDULE_ID}`;

function detailRoutes(over: Partial<{
  schedule: unknown; occurrences: unknown; changes: unknown;
}> = {}): StubRoute[] {
  return [
    ...sessionRoutes(),
    { path: `${BASE}/occurrences`, body: over.occurrences ?? { occurrences: [
      occurrenceFixture("2026-10-06", { status: "past" }),
      occurrenceFixture("2026-10-13"),
      occurrenceFixture("2026-10-20", { status: "skipped", courts: [] }),
    ] } },
    { path: `${BASE}/changes`, body: over.changes ?? { rows: [changeRowFixture()], retention: "kept indefinitely — these records cannot be deleted" } },
    { path: BASE, body: over.schedule ?? scheduleRowFixture() },
  ];
}

function renderDetail() {
  return renderPage(
    <Routes>
      <Route path="/admin/schedules/:id" element={<AdminScheduleDetailPage />} />
    </Routes>,
    { initialEntries: [`/admin/schedules/${SCHEDULE_ID}`] },
  );
}

beforeEach(() => {
  signIn({ isAdmin: true });
  forgetClubZone();
});

afterEach(() => {
  signOut();
  vi.unstubAllGlobals();
});

describe("what it holds", () => {
  it("reads the rule back as the same sentence the editor wrote", async () => {
    stubFetch(detailRoutes());
    renderDetail();

    expect(await screen.findByRole("heading", { name: "Tuesday league", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(
      "Holds Courts 1, 2 and 3 on Tuesdays from 18:00 to 21:00, called “League night”, "
      + "from Tue 6 Oct until Tue 15 Dec.",
    )).toBeInTheDocument();
  });

  it("gives every date a word, including the state it was not told", async () => {
    stubFetch(detailRoutes({
      occurrences: { occurrences: [occurrenceFixture("2026-10-13", { status: undefined })] },
    }));
    renderDetail();

    // Never a blank cell: "Not known" is a state, and an empty one is a screen pretending.
    expect(await screen.findByText(/^Not known · /)).toBeInTheDocument();
  });

  it("never renders 'no dates' over a read that failed", async () => {
    stubFetch(detailRoutes({ occurrences: undefined }).map((r) => (
      r.path === `${BASE}/occurrences` ? { ...r, status: 503, body: { error: "server_error" } } : r
    )));
    renderDetail();

    expect(await screen.findByText(/That does not mean it holds none\./)).toBeInTheDocument();
    expect(screen.queryByText(/No dates yet/)).not.toBeInTheDocument();
  });
});

describe("skipping a date", () => {
  it("labels a skipped date by what pressing it does", async () => {
    stubFetch(detailRoutes());
    renderDetail();

    expect(await screen.findByRole("button", { name: "20 October 2026 — restore this Tuesday" }))
      .toBeInTheDocument();
  });

  it("says what opens back up before anything is skipped", async () => {
    stubFetch([
      ...detailRoutes(),
      { method: "PATCH", path: `${BASE}/occurrences/2026-10-13`, body: { date: "2026-10-13", status: "skipped" } },
    ]);
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Skip Tue 13 Oct" }));
    expect(screen.getAllByText(
      /3 courts open back up on 13 October 2026\. Members will be able to book them\./,
    ).length).toBeGreaterThan(0);
    // P3: the confirm is a dialog; its way out names the outcome.
    expect(within(await screen.findByRole("dialog")).getByRole("button", { name: "Keep it" })).toBeInTheDocument();
  });

  it("refuses a date that has already happened, as a sentence and not as a code", async () => {
    stubFetch([
      ...detailRoutes(),
      {
        method: "PATCH",
        path: `${BASE}/occurrences/2026-10-13`,
        status: 409,
        body: { error: "occurrence_in_past", occurrence_date: "2026-10-13" },
      },
    ]);
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Skip Tue 13 Oct" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Skip Tue 13 Oct" }));

    expect(await screen.findByText(
      /That date has already happened, so it cannot be changed\./,
    )).toBeInTheDocument();
  });
});

/** The hours are TimeSelects now (P3, R7 — slice-aligned, never free-typed). */
function pickTime(label: string, time: string) {
  fireEvent.pointerDown(screen.getByRole("combobox", { name: label }), { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(screen.getByRole("option", { name: time }));
}

describe("changing the hours", () => {
  async function openTheChange() {
    await userEvent.click(await screen.findByRole("button", { name: "Change the hours of Tue 13 Oct" }));
  }

  it("asks which dates, and states the third fact whether or not anyone asked", async () => {
    stubFetch(detailRoutes());
    renderDetail();
    await openTheChange();

    expect(screen.getByRole("radiogroup", { name: "Change which Tuesdays?" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Just Tue 13 Oct" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Tue 13 Oct and every Tuesday after it" })).toBeInTheDocument();
    expect(screen.getByText(
      "Tuesdays before 13 October 2026 never change — what already happened stays as it happened.",
    )).toBeInTheDocument();
  });

  it("changes only that date through the occurrence route", async () => {
    const stub = stubFetch([
      ...detailRoutes(),
      {
        method: "PATCH",
        path: `${BASE}/occurrences/2026-10-13`,
        body: { date: "2026-10-13", status: "overridden" },
      },
    ]);
    renderDetail();
    await openTheChange();

    await userEvent.click(screen.getByRole("radio", { name: "Just Tue 13 Oct" }));
    pickTime("New start time", "19:00");
    pickTime("New end time", "21:30");
    await userEvent.type(screen.getByLabelText("Reason (kept in the change record)"), "League starts later");
    // The primary button restates the option chosen — the last thing read before the press.
    await userEvent.click(screen.getByRole("button", { name: "Change just Tue 13 Oct to 19:00–21:30" }));

    const call = stub.calls.find((c) => c.method === "PATCH" && c.path.endsWith("/occurrences/2026-10-13"));
    expect(call?.body).toMatchObject({ start: "19:00", end: "21:30", reason: "League starts later" });
  });

  it("changes this and every one after it through the schedule route, with the date", async () => {
    const stub = stubFetch([
      ...detailRoutes(),
      { method: "PATCH", path: BASE, body: scheduleRowFixture({ start: "19:00", end: "21:30" }) },
    ]);
    renderDetail();
    await openTheChange();

    await userEvent.click(screen.getByRole("radio", { name: "Tue 13 Oct and every Tuesday after it" }));
    pickTime("New start time", "19:00");
    pickTime("New end time", "21:30");
    await userEvent.type(screen.getByLabelText("Reason (kept in the change record)"), "League starts later");
    await userEvent.click(screen.getByRole("button", {
      name: "Change Tue 13 Oct and every Tuesday after it to 19:00–21:30",
    }));

    const call = stub.calls.find((c) => c.method === "PATCH" && c.path === BASE);
    expect(call?.body).toMatchObject({ start: "19:00", end: "21:30", effectiveFrom: "2026-10-13" });
  });

  it("says out loud when the server moved the date forward rather than refusing it", async () => {
    stubFetch([
      ...detailRoutes(),
      {
        method: "PATCH",
        path: BASE,
        body: { ...scheduleRowFixture(), effective_from_clamped_to: "2026-09-22" },
      },
    ]);
    renderDetail();
    await openTheChange();

    await userEvent.click(screen.getByRole("radio", { name: "Tue 13 Oct and every Tuesday after it" }));
    pickTime("New start time", "19:00");
    pickTime("New end time", "21:30");
    await userEvent.type(screen.getByLabelText("Reason (kept in the change record)"), "League starts later");
    await userEvent.click(screen.getByRole("button", {
      name: "Change Tue 13 Oct and every Tuesday after it to 19:00–21:30",
    }));

    expect(await screen.findByText(
      /That date has already passed, so the change starts from 22 September 2026 instead\./,
    )).toBeInTheDocument();
  });

  it("does not offer a change with an end before its start", async () => {
    stubFetch(detailRoutes());
    renderDetail();
    await openTheChange();

    pickTime("New start time", "21:00");
    pickTime("New end time", "19:00");

    expect(await screen.findByText(
      "The end time has to be after the start time, on the same day.",
    )).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change just Tue 13 Oct to 21:00–19:00" })).toBeDisabled();
  });
});

describe("there is no delete", () => {
  it("offers ending, and names the count and the refunds before it happens", async () => {
    stubFetch(detailRoutes());
    renderDetail();
    await screen.findByRole("heading", { name: "Tuesday league", level: 1 });

    // D2 §11.5: a schedule that ran is history. Nothing on this page deletes one.
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "End Tuesday league" }));
    const consequence = screen.getAllByText(
      /Ending this stops 1 more Tuesday and releases 36 held slots, which members can then book\./,
    );
    expect(consequence.length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Nobody is refunded — nobody was charged for a hold\./).length)
      .toBeGreaterThan(0);
    expect(screen.getAllByText(/Tuesdays that have already happened stay exactly as they are\./).length)
      .toBeGreaterThan(0);
  });

  it("does not promise a release it could not count", async () => {
    // The dates read failed. "releases 0 held slots" is a figure nobody computed, printed in
    // the armed consequence of a destructive control — which is the worst place for one.
    stubFetch(detailRoutes().map((r) => (
      r.path === `${BASE}/occurrences` ? { ...r, status: 503, body: { error: "server_error" } } : r
    )));
    renderDetail();
    await screen.findByRole("heading", { name: "Tuesday league", level: 1 });

    await userEvent.click(screen.getByRole("button", { name: "End Tuesday league" }));
    expect(screen.getAllByText(
      /Ending this stops every date still ahead, and the slots it was holding can be booked again\./,
    ).length).toBeGreaterThan(0);
    expect(screen.queryByText(/releases 0 held slots/)).not.toBeInTheDocument();
    expect(screen.queryByText(/stops 0 more/)).not.toBeInTheDocument();
  });

  it("ends the series through the end route, with the reason", async () => {
    const stub = stubFetch([
      ...detailRoutes(),
      { method: "POST", path: `${BASE}/end`, body: scheduleRowFixture({ status: "ended" }) },
    ]);
    renderDetail();
    await screen.findByRole("heading", { name: "Tuesday league", level: 1 });

    await userEvent.type(screen.getByLabelText(/Reason for ending/), "League season finished");
    await userEvent.click(screen.getByRole("button", { name: "End Tuesday league" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "End Tuesday league" }));

    const call = stub.calls.find((c) => c.path.endsWith("/end"));
    expect(call?.body).toMatchObject({ reason: "League season finished" });
  });
});

describe("the change record", () => {
  it("shows what has been changed here, and says nobody can delete it", async () => {
    stubFetch(detailRoutes());
    renderDetail();

    const record = await screen.findByRole("region", { name: "What has been changed here" });
    expect(within(record).getByText("Created Tuesday league")).toBeInTheDocument();
    expect(within(record).getByText("Nobody can delete these from the app, including admins."))
      .toBeInTheDocument();
    // Read-only means read-only: no control inside that region writes anything.
    expect(within(record).queryAllByRole("button")).toHaveLength(0);
  });

  it("says nothing has been changed only when the read succeeded", async () => {
    stubFetch(detailRoutes().map((r) => (
      r.path === `${BASE}/changes` ? { ...r, status: 503, body: { error: "server_error" } } : r
    )));
    renderDetail();

    const record = await screen.findByRole("region", { name: "What has been changed here" });
    expect(within(record).getByText(/That does not mean nothing has been changed\./)).toBeInTheDocument();
    expect(within(record).queryByText(/Nothing has been changed here yet/)).not.toBeInTheDocument();
  });
});
