import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AdminSettingsPage from "./AdminSettings";
import { COURTS_FIXTURE, SETTINGS_FIXTURE, renderPage, stubFetch, type StubRoute } from "../test/harness";

/**
 * The settings rows for everything this release made configurable — ruling 13.
 *
 * <p>
 * "Every configurable number is a `tenant_settings` key with validation and an admin settings
 * UI row." Before this, the box's screen timeout and its rapid-scan window were hardcoded in
 * firmware, the per-day slot ceiling did not exist at all, and the one number that WAS a key
 * defaulted to three seconds of unlocked door.
 * </p>
 *
 * <p>
 * The property that carries this file is not "the fields are there" — it is that the page
 * behaves correctly against an API that serves SOME of them, which is the API this frontend
 * is shipping alongside. Three backend lanes are writing these keys in parallel.
 * </p>
 */

vi.setConfig({ testTimeout: 20_000 });

const routes = (extra: Record<string, unknown> = {}): StubRoute[] => [
  { path: "/api/v1/admin/settings/", body: { ...SETTINGS_FIXTURE, ...extra } },
  { path: "/api/v1/admin/courts/", body: COURTS_FIXTURE },
  { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
];

/** The full set, as a club on a backend that has shipped everything would see it. */
const ALL = {
  lcd_revert_seconds: 10,
  rapid_scan_window_seconds: 10,
  member_max_slots_per_day: 4,
  admin_bulk_max_items: 100,
  schedule_materialisation_days: 60,
  schedule_max_rows_per_change: 2000,
  device_error_retention_days: 90,
  device_error_max_open_rows: 200,
  sse_keepalive_seconds: 25,
  realtime_fallback_after_failures: 3,
  realtime_poll_seconds_control_board: 10,
  control_board_resync_seconds: 300,
  action_glyphs: "thumbs",
  member_trace_enabled: true,
};

describe("the settings rows this release owes", () => {
  it("gives the box's screen timeout and the rapid-scan window a row each", async () => {
    stubFetch(routes(ALL));
    renderPage(<AdminSettingsPage />);

    // GOAL item 1 and item 18. Both were firmware constants with no way to change them.
    expect(await screen.findByLabelText(/Screen returns to the start after/)).toHaveValue(10);
    expect(screen.getByLabelText(/Next person may scan within/)).toHaveValue(10);
    // And the block says WHEN a change takes effect, because a pull-only box is never told
    // anything except in the answer to a call it made itself. In the estate's own words —
    // "the next time it calls in" — and NOT "on its next heartbeat", which is a protocol
    // detail wearing a sentence and which `settings-door-validation.test.tsx` holds the
    // whole page to.
    expect(screen.getByText(/picks these up the next time it calls in/)).toBeInTheDocument();
  });

  it("gives the per-day slot ceiling a row, in slots, as Dean asked", async () => {
    stubFetch(routes(ALL));
    renderPage(<AdminSettingsPage />);
    expect(await screen.findByLabelText("Slots per member per day")).toHaveValue(4);
  });

  /**
   * <b>Ruling 3: the two caps compose, and neither field alone says so.</b> A club that sets
   * "4 slots" and leaves the minutes at 60 has set an hour, and would never have learned it
   * from either field.
   */
  it("says which of the two per-day caps a member actually meets", async () => {
    stubFetch(routes({ ...ALL, member_max_slots_per_day: 8, member_per_day_max_minutes: 60, slice_minutes: 15 }));
    renderPage(<AdminSettingsPage />);

    // 8 slots is 120 minutes; 60 minutes is stricter, so the minutes cap is the real one.
    expect(await screen.findByText(/60 minutes a day is stricter than 8 slots a day/)).toBeInTheDocument();
    expect(screen.getByText(/Admins are not limited/)).toBeInTheDocument();
  });

  it("says the other way round when the slot cap is the stricter one", async () => {
    stubFetch(routes({ ...ALL, member_max_slots_per_day: 2, member_per_day_max_minutes: 60, slice_minutes: 15 }));
    renderPage(<AdminSettingsPage />);
    expect(await screen.findByText(/2 slots a day is 30 minutes, so the slot limit is the one a member meets/))
      .toBeInTheDocument();
  });

  it("does not quote a slot cap the club's system has not got", async () => {
    // The key is absent — this frontend ships before the backend lane's migration — so the
    // sentence says what IS true rather than a default the console invented.
    stubFetch(routes({ member_per_day_max_minutes: 60 }));
    renderPage(<AdminSettingsPage />);
    expect(await screen.findByText(/Today a member may hold 60 minutes a day/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Slots per member per day")).not.toBeInTheDocument();
  });

  /**
   * <b>The shape that matters while three backend lanes are still writing these keys.</b> A
   * row for a setting the club does not have is a row somebody edits and then cannot save,
   * and an input bound to `undefined` is an uncontrolled input that silently sends nothing.
   */
  it("renders no row at all for a key the API does not serve, and says why the block is empty", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    await screen.findByRole("heading", { name: "Box screens & scanning" });
    expect(screen.queryByLabelText(/Screen returns to the start after/)).not.toBeInTheDocument();
    // Both halves: the club's system has not got these, which is not the same as the club
    // having turned them off.
    expect(screen.getAllByText(/not serving these settings yet/).length).toBeGreaterThan(0);
  });

  it("refuses a number outside its bound, at the field and on the save bar", async () => {
    const stub = stubFetch(routes(ALL));
    renderPage(<AdminSettingsPage />);

    const field = await screen.findByLabelText("Slots per member per day");
    fireEvent.change(field, { target: { value: "200" } });

    const save = screen.getByRole("button", { name: /Save settings/ });
    fireEvent.click(save);
    // Twice, on purpose and as the name of this test says: at the field, and on the save bar
    // that lists everything standing between this page and a save.
    expect((await screen.findAllByText(/has to be a whole number between 0 and 96/)).length)
      .toBeGreaterThanOrEqual(2);
    expect(stub.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  /**
   * The cross-field rule, and the one whose failure appears weeks later: a member books
   * ninety days ahead into a league night that is only written sixty days ahead, and nothing
   * goes wrong until the week it does.
   */
  it("refuses a booking window that reaches past where repeating bookings are written", async () => {
    const stub = stubFetch(routes({ ...ALL, advance_booking_days: 14 }));
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await screen.findByLabelText(/Reserve window/), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

    expect((await screen.findAllByText(/book into a league night that has not been written yet/)).length)
      .toBeGreaterThanOrEqual(1);
    expect(stub.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("sends every changed key in camelCase, and omits the ones it was never given", async () => {
    const stub = stubFetch(routes(ALL));
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await screen.findByLabelText(/Screen returns to the start after/), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

    await waitFor(() => {
      const put = stub.calls.find((c) => c.method === "PUT");
      expect(put?.body).toEqual(expect.objectContaining({
        lcdRevertSeconds: 20, memberMaxSlotsPerDay: 4, sseKeepaliveSeconds: 25, actionGlyphs: "thumbs",
      }));
    });
  });

  it("sends nothing at all for the keys an older API did not serve", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    await screen.findByRole("heading", { name: "Monitoring & live updates" });
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

    await waitFor(() => {
      const put = stub.calls.find((c) => c.method === "PUT");
      // Absent, not null: omitted-means-unchanged is what lets one Save button carry these
      // against a backend that serves only some of them.
      expect(put?.raw).not.toContain("lcdRevertSeconds");
      expect(put?.raw).not.toContain("memberTraceEnabled");
    });
  });

  it("offers the glyph set as a choice, defaulting to thumbs, and exempts destructive confirms in words", async () => {
    stubFetch(routes(ALL));
    renderPage(<AdminSettingsPage />);

    // Ruling 4: Dean asked for thumbs and the club is South African, where a thumbs-up is
    // unambiguously positive. A club that reads it otherwise flips one key.
    expect(await screen.findByLabelText("Yes and no icons")).toHaveValue("thumbs");
    expect(screen.getByText(/a thumbs-up on “Delete” would be wrong/)).toBeInTheDocument();
  });

  /**
   * The most consequential control on the page, and it is a switch: off, the per-person
   * night page is not there at all. The hint says 404 rather than 403 in plain words,
   * because a refusal would confirm the surface exists and that this member has one.
   */
  it("offers the night-trace kill switch, and says what off actually means", async () => {
    stubFetch(routes(ALL));
    renderPage(<AdminSettingsPage />);

    const toggle = await screen.findByLabelText(/every look is recorded/);
    expect(toggle).toBeChecked();
    expect(screen.getByText(/not there at all — not greyed out, not refused, simply absent/))
      .toBeInTheDocument();
  });

  it("does not render the kill switch as off for an API that has not shipped it", async () => {
    // A switch bound to `undefined` reads "off" about a feature that is on.
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);
    await screen.findByRole("heading", { name: "Monitoring & live updates" });
    expect(screen.queryByLabelText(/every look is recorded/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/the page is not there/)).not.toBeInTheDocument();
  });

  it("names the three new blocks in the jump nav, so they are reachable by keyboard", async () => {
    stubFetch(routes(ALL));
    renderPage(<AdminSettingsPage />);

    // The nav exists because a keyboard user counted seventy-six tab stops to the first door
    // setting. Three more blocks without three more nav entries is that finding, re-shipped.
    for (const name of ["Box screens & scanning", "Limits & confirmations", "Monitoring & live updates"]) {
      expect((await screen.findAllByText(name)).length).toBeGreaterThan(1);
    }
  });
});
