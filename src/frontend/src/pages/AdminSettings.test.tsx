import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AdminSettingsPage from "./AdminSettings";
import { SETTINGS_FIXTURE, renderPage, stubFetch } from "../test/harness";

/**
 * The settings screen.
 *
 * <p>
 * Nine keys the engine has always read were editable only by hand-editing a JSON column
 * on a live money system — conversion rates, top-up caps, the per-day limit, peak hours,
 * retention. They are on the screen now, and these tests hold two things: that they are
 * actually there, and that saving them does not revert a button remap made from the
 * devices page.
 * </p>
 *
 * <p>
 * That second one is the interesting failure. The API reads an absent key as unchanged,
 * so two screens editing one document only work if each omits what it does not own.
 * </p>
 */
describe("AdminSettings", () => {
  afterEach(() => vi.unstubAllGlobals());

  const routes = () => [
    { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
    { path: "/api/v1/admin/courts/", body: [] },
  ];

  it("shows the economics keys that used to need a database client", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    expect(await screen.findByLabelText(/Credits per R1 — members/)).toHaveValue(1.6);
    expect(screen.getByLabelText(/Credits per R1 — league/)).toHaveValue(2.4);
    expect(screen.getByLabelText(/Top-up block/)).toHaveValue(100);
    expect(screen.getByLabelText(/Top-up cap per member/)).toHaveValue(1000);
    expect(screen.getByLabelText(/Court time per member per day/)).toHaveValue(60);
    expect(screen.getByLabelText(/^Peak hours/)).toHaveValue("16:00-19:00");
    expect(screen.getByLabelText(/Peak opens to everyone/)).toHaveValue(1);
    expect(screen.getByLabelText(/Keep usage history/)).toHaveValue(2);
    expect(screen.getByLabelText(/No-show sweep looks back/)).toHaveValue(7);
  });

  it("sends an edited economics value and leaves the button map alone", async () => {
    const stub = stubFetch([
      ...routes(),
      { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
    ]);

    renderPage(<AdminSettingsPage />);

    fireEvent.change(await screen.findByLabelText(/Credits per R1 — league/), { target: { value: "2.8" } });
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

    await waitFor(() => {
      const save = stub.calls.find((c) => c.method === "PUT");
      expect(save).toBeTruthy();
      const body = save!.body as Record<string, unknown>;

      expect(body.creditsPerZarLeague).toBe(2.8);

      // The button map is the devices page's business. Sending a stale copy from here
      // would silently undo a remap somebody made there — and the API cannot tell the
      // difference between "unchanged" and "changed back".
      expect(body).not.toHaveProperty("buttonMap");
    });
  });

  it("shows the six court-box numbers and sends them back on save", async () => {
    const stub = stubFetch([
      ...routes(),
      { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
    ]);

    renderPage(<AdminSettingsPage />);

    // Served by GET /admin/settings since the programme added them, and until now
    // absent from this page — an admin could see none of them and change none of them.
    expect(await screen.findByLabelText(/Walk-up maximum/)).toHaveValue(90);
    expect(screen.getByLabelText(/Heartbeat interval/)).toHaveValue(60);
    expect(screen.getByLabelText(/Booking lookahead at the box/)).toHaveValue(120);
    expect(screen.getByLabelText(/Lights on this early/)).toHaveValue(10);
    expect(screen.getByLabelText(/Court code lifetime/)).toHaveValue(60);
    expect(screen.getByLabelText(/Offline roster reach/)).toHaveValue(120);

    // The API's bounds, on the inputs, so the form cannot offer a value the save refuses.
    expect(screen.getByLabelText(/Walk-up maximum/)).toHaveAttribute("max", "90");
    // 15-300, not the API's old 10-3600: the box clamps its own cadence to 15-300, so
    // anything outside it is a number no box runs, and the Devices page's offline
    // threshold is three beats of it (review finding 22).
    expect(screen.getByLabelText(/Heartbeat interval/)).toHaveAttribute("min", "15");
    expect(screen.getByLabelText(/Heartbeat interval/)).toHaveAttribute("max", "300");
    expect(screen.getByLabelText(/Court code lifetime/)).toHaveAttribute("min", "15");
    // The cue must fit inside the forward window; the cap follows the window's value.
    expect(screen.getByLabelText(/Lights on this early/)).toHaveAttribute("max", "120");

    // The two court-box windows, named for what they actually do.
    //
    // They were described the wrong way round. The field labelled "Activation window
    // before a booking", hinted "How early a scan may switch a booking's lights on",
    // controls nothing of the kind: measured against a real box, raising it from 120 to
    // 1440 left a scan 19.5 minutes early still answering `too_early`, and raising the
    // CUE from 10 to 30 lit the court. `activation_forward_window_minutes` only decides
    // whether the box RECOGNISES the booking (outside it: `no_booking`);
    // `activation_cue_window_minutes` is the one that lights it. An admin wanting members
    // to open the court half an hour early edited the field that said so, saw "Settings
    // saved.", and changed nothing — and nothing on the screen pointed at the field that
    // works.
    // The hint is a separate <p> wired by aria-describedby, which is also what a screen
    // reader reads out with the field.
    const hintOf = (field: HTMLElement) =>
      document.getElementById(field.getAttribute("aria-describedby")!)!.textContent!;

    const cueHint = hintOf(screen.getByLabelText(/Lights on this early/));
    expect(cueHint).toMatch(/decides how early a scan actually switches a booking's lights on/);

    const lookaheadHint = hintOf(screen.getByLabelText(/Booking lookahead at the box/));
    expect(lookaheadHint).toMatch(/recognises a booking at all/);
    expect(lookaheadHint).toMatch(/does NOT decide when the lights come on/i);

    // And the sentence that sent admins to the wrong field is gone for good.
    expect(screen.queryByText(/How early a scan may switch a booking's lights on/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Court code lifetime/), { target: { value: "45" } });
    fireEvent.change(screen.getByLabelText(/Walk-up maximum/), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

    await waitFor(() => {
      const save = stub.calls.find((c) => c.method === "PUT");
      expect(save).toBeTruthy();
      const body = save!.body as Record<string, unknown>;
      // The edited two, changed; the other four, round-tripped as read. The save
      // mapper used to strip all six, so a save from here reset none — and changed none.
      expect(body).toMatchObject({
        qrLifetimeSeconds: 45,
        walkUpMaxMinutes: 60,
        heartbeatSeconds: 60,
        activationForwardWindowMinutes: 120,
        activationCueWindowMinutes: 10,
        rosterWindowMinutes: 120,
      });
    });
  });

  it("prices courts in credits, not rand", async () => {
    stubFetch([
      { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
      { path: "/api/v1/admin/courts/", body: [{ id: "c1", court_number: 1, name: "Court 1", court_type: "Squash", slice_price_credits: 8, is_active: true }] },
    ]);

    renderPage(<AdminSettingsPage />);

    // A court's slice price is what a member is CHARGED, in credits — the unit of
    // account. The field was labelled "(R)", so the admin priced courts in the wrong unit.
    expect(await screen.findByLabelText(/Price per slice \(credits\)/)).toBeInTheDocument();
    expect(screen.getByLabelText("Court 1 price per slice (credits)")).toHaveValue(8);
    expect(screen.queryByLabelText(/Price per slice \(R\)/)).not.toBeInTheDocument();
  });

  it("shows the API's reason when a value is refused", async () => {
    stubFetch([
      ...routes(),
      { method: "PUT", path: "/api/v1/admin/settings/", status: 400, body: { error: "topup_max_below_block" } },
    ]);

    renderPage(<AdminSettingsPage />);

    fireEvent.change(await screen.findByLabelText(/Top-up cap per member/), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

    // A cap below the block size means no top-up is ever legal, which reads to a member
    // as the payment page being broken. The admin has to be told which value, not just
    // that something failed.
    expect(await screen.findByText(/topup max below block/)).toBeInTheDocument();
  });
});

/**
 * The club's timezone, and the heartbeat hint that was true only above 60 seconds.
 */
describe("AdminSettings — timezone and the offline threshold", () => {
  afterEach(() => vi.unstubAllGlobals());

  const routes = (settings: Record<string, unknown> = {}) => [
    { path: "/api/v1/admin/settings/", body: { ...SETTINGS_FIXTURE, ...settings } },
    { path: "/api/v1/admin/courts/", body: [] },
    { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
  ];

  /**
   * `tenant_settings.timezone` drives every wall-clock time on the booking grid and was
   * readable but not writable: the GET served it, the PUT had no member for it, and a club
   * outside South Africa read its whole schedule in Johannesburg time with no correction
   * short of an UPDATE on a JSON column.
   */
  it("offers the club's timezone and sends a change", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const tz = await screen.findByLabelText("Timezone");
    expect(tz).toHaveValue("Africa/Johannesburg");

    fireEvent.change(tz, { target: { value: "Europe/London" } });
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

    await waitFor(() => {
      const save = stub.calls.find((c) => c.method === "PUT");
      expect((save?.body as Record<string, unknown>).timezone).toBe("Europe/London");
    });
  });

  /**
   * A zone the runtime's tzdb does not list must still be selectable, or the picker shows
   * the club a zone it is not on and then saves that.
   */
  it("keeps a saved zone the runtime does not know about", async () => {
    stubFetch(routes({ timezone: "Mars/Olympus_Mons" }));
    renderPage(<AdminSettingsPage />);

    expect(await screen.findByLabelText("Timezone")).toHaveValue("Mars/Olympus_Mons");
  });

  /**
   * D-F13. The hint promised "three missed beats", which is true only above 60 seconds —
   * below that the 180-second floor takes over. An admin lowering the interval to detect an
   * outage faster got none of the improvement and no explanation.
   */
  it("says what the chosen heartbeat actually buys, floor included", async () => {
    stubFetch(routes({ heartbeat_seconds: 15 }));
    renderPage(<AdminSettingsPage />);

    const hint = (await screen.findByLabelText(/Heartbeat interval/)).getAttribute("aria-describedby");
    const text = document.getElementById(hint!)!.textContent!;

    // At 15s the box reports offline_after_seconds: 180, not 45.
    expect(text).toMatch(/three missed beats or 3 minutes, whichever is longer/);
    expect(text).toMatch(/at 15s that is 3 minutes/);
  });

  it("says the larger number when the interval is above the floor", async () => {
    stubFetch(routes({ heartbeat_seconds: 120 }));
    renderPage(<AdminSettingsPage />);

    const hint = (await screen.findByLabelText(/Heartbeat interval/)).getAttribute("aria-describedby");
    expect(document.getElementById(hint!)!.textContent).toMatch(/at 120s that is 6 minutes/);
  });
});

/**
 * R2 G-F2 — a club could not change its opening hours.
 *
 * <p>
 * The screen offered one flat "Day starts / Day ends" pair. The engine reads
 * `operating_hours`, a per-weekday map, and the seed names all seven days — so the pair the
 * console could edit governed nothing at all. Saving `Day starts 00:00` / `Day ends 23:45`
 * answered `200 {"saved":true}` and left Saturday running 07:00–19:45 and Monday
 * 06:00–21:45, which is exactly what a finder watched happen twice with different values.
 * </p>
 */
describe("AdminSettings — opening hours per weekday", () => {
  afterEach(() => vi.unstubAllGlobals());

  const routes = (settings: Record<string, unknown> = {}) => [
    { path: "/api/v1/admin/settings/", body: { ...SETTINGS_FIXTURE, ...settings } },
    { path: "/api/v1/admin/courts/", body: [] },
    { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
  ];

  it("shows the hours the booking rule actually enforces, weekday by weekday", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    expect(await screen.findByLabelText("Saturday opens")).toHaveValue("07:00");
    expect(screen.getByLabelText("Saturday closes")).toHaveValue("20:00");
    expect(screen.getByLabelText("Monday opens")).toHaveValue("06:00");

    // Sunday is not in the map, so it follows the flat pair — and the row says so rather
    // than showing hours nobody set.
    expect(screen.getByLabelText("Sunday has its own hours")).not.toBeChecked();
    expect(screen.getByText(/Club default — 06:00 to 22:00/)).toBeInTheDocument();
  });

  it("saves an edited weekday, and the save carries the whole map", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await screen.findByLabelText("Saturday closes"), { target: { value: "13:00" } });
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

    await waitFor(() => {
      const save = stub.calls.find((c) => c.method === "PUT");
      expect(save).toBeTruthy();
      const hours = (save!.body as { operatingHours: Record<string, string> }).operatingHours;
      expect(hours.sat).toBe("07:00-13:00");
      // The other days go as they were: the API replaces the map wholesale, so sending
      // only the edited day would silently delete the rest of the week.
      expect(hours.mon).toBe("06:00-22:00");
      expect(hours.sun).toBeUndefined();
    });
  });

  it("puts a day back on the club default when its own hours are switched off", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.click(await screen.findByLabelText("Saturday has its own hours"));
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

    await waitFor(() => {
      const save = stub.calls.find((c) => c.method === "PUT");
      const hours = (save!.body as { operatingHours: Record<string, string> }).operatingHours;
      expect(hours.sat).toBeUndefined();
      expect(hours.mon).toBe("06:00-22:00");
    });
  });

  it("starts a newly-custom day at the club default rather than at midnight", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.click(await screen.findByLabelText("Sunday has its own hours"));

    expect(screen.getByLabelText("Sunday opens")).toHaveValue("06:00");
    expect(screen.getByLabelText("Sunday closes")).toHaveValue("22:00");
  });

  it("refuses a close that is not after the open, at the row, before anything is sent", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await screen.findByLabelText("Saturday closes"), { target: { value: "06:00" } });

    // Said where the mistake is. A club that means "shut on Saturday" has to say so by
    // some other means — the engine has no closed-all-day, and reading 20:00–07:00 as an
    // overnight club would sell the small hours.
    expect(screen.getByText(/Closing time has to be after opening time/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save settings/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PUT")).toBe(false));
  });
});
