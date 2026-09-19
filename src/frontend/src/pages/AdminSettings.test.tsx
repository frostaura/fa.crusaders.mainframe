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

/**
 * The three door-gate numbers.
 *
 * <p>
 * Their own block rather than three more fields under "Court boxes": a door and a box share
 * the key, the heartbeat and nothing else. Every hint here states a BEHAVIOUR rather than a
 * bound, because the two activation windows one block above were described the wrong way
 * round for months — an admin edited the field whose hint said what they wanted, saw
 * "Settings saved.", and changed nothing.
 * </p>
 */
describe("AdminSettings — door gates", () => {
  afterEach(() => vi.unstubAllGlobals());

  const routes = (settings: Record<string, unknown> = {}) => [
    { path: "/api/v1/admin/settings/", body: { ...SETTINGS_FIXTURE, ...settings } },
    { path: "/api/v1/admin/courts/", body: [] },
    { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
  ];

  /** The hint is a separate <p> wired by aria-describedby — what a screen reader reads out. */
  const hintOf = (field: HTMLElement) =>
    document.getElementById(field.getAttribute("aria-describedby")!)!.textContent!;

  it("shows the three door settings with the API's own bounds on the inputs", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const unlock = await screen.findByLabelText(/Unlock time/);
    expect(unlock).toHaveValue(3);
    expect(unlock).toHaveAttribute("min", "1");
    expect(unlock).toHaveAttribute("max", "30");

    const early = screen.getByLabelText(/Early entry/);
    expect(early).toHaveValue(30);
    expect(early).toHaveAttribute("min", "0");
    expect(early).toHaveAttribute("max", "240");

    expect(screen.getByLabelText(/Who may open a door/)).toHaveValue("active_member");
  });

  it("offers both policies and nothing else", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const picker = await screen.findByLabelText(/Who may open a door/);
    const values = Array.from(picker.querySelectorAll("option")).map((o) => o.getAttribute("value"));
    expect(values).toEqual(["active_member", "booking_window"]);
    expect(picker.textContent).toContain("Any member in good standing");
    expect(picker.textContent).toContain("Only a member with a booking");
  });

  /**
   * The unlock hint states what the HARDWARE will do, not only what the form accepts. "1–30"
   * on its own reads as an arbitrary form limit; the firmware's own cap is why it is that
   * number, and an admin who wants a door held open for a minute needs to know it is not on
   * offer anywhere rather than go looking for another setting.
   */
  it("says the unlock bound is the door's, not the form's", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const hint = hintOf(await screen.findByLabelText(/Unlock time/));
    expect(hint).toMatch(/1–30/);
    expect(hint).toMatch(/never holds it open longer than 30 seconds, whatever is set here/);
  });

  /**
   * Each policy's hint names the accounts that pass either way. "A user with no membership
   * row is not barred" is how an operator or a club admin opens a door at all, and nobody
   * would guess it from a label reading "Any member in good standing".
   */
  it("describes the policy that is actually selected, and names who always passes", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const picker = await screen.findByLabelText(/Who may open a door/);
    expect(hintOf(picker)).toMatch(/unless their membership is suspended, pending approval or rejected/);
    expect(hintOf(picker)).toMatch(/club admins and operators, always pass/);

    fireEvent.change(picker, { target: { value: "booking_window" } });
    // The hint follows the choice rather than describing both at once, and it spells out the
    // early-entry number rather than making an admin scroll and do arithmetic.
    expect(hintOf(screen.getByLabelText(/Who may open a door/)))
      .toMatch(/starts within the next 30 minutes/);
    expect(hintOf(screen.getByLabelText(/Who may open a door/))).toMatch(/Anyone else is turned away/);
  });

  it("follows the early-entry number into the strict policy's hint", async () => {
    stubFetch(routes({ gate_access_policy: "booking_window", gate_early_entry_minutes: 90 }));
    renderPage(<AdminSettingsPage />);

    expect(hintOf(await screen.findByLabelText(/Who may open a door/)))
      .toMatch(/starts within the next 90 minutes/);

    fireEvent.change(screen.getByLabelText(/Early entry/), { target: { value: "5" } });
    expect(hintOf(screen.getByLabelText(/Who may open a door/)))
      .toMatch(/starts within the next 5 minutes/);
  });

  /**
   * <b>The degraded mode.</b> It is the one door behaviour nobody would predict from the
   * controls: whichever policy is chosen, a door that loses the network falls back to a
   * roster built from BOOKINGS, so the open policy silently becomes booking-only for the
   * length of the outage. An admin who does not know that reads a member locked out during
   * an outage as a broken lock and sends somebody to look at the hardware.
   */
  it("says that an offline door admits only booked members, whichever policy is set", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const block = await screen.findByText(/How the doors behave/);
    expect(block).toHaveTextContent("falls back to the roster it last downloaded");
    expect(block).toHaveTextContent("that roster holds bookings and nothing else");
    expect(block).toHaveTextContent(
      "only members with an upcoming or running booking can get in — whichever policy is set below");
  });

  it("sends the three door settings on save, and leaves the button map alone", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await screen.findByLabelText(/Unlock time/), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText(/Who may open a door/), { target: { value: "booking_window" } });
    fireEvent.change(screen.getByLabelText(/Early entry/), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

    await waitFor(() => {
      const save = stub.calls.find((c) => c.method === "PUT");
      expect(save).toBeTruthy();
      expect(save!.body).toMatchObject({
        gateUnlockSeconds: 7,
        gateAccessPolicy: "booking_window",
        gateEarlyEntryMinutes: 45,
      });
      // Still not this screen's business, gates or no gates.
      expect(save!.body).not.toHaveProperty("buttonMap");
    });
  });

  /**
   * <b>Validation, because the inputs are not enough.</b> A number input's min and max stop
   * the SPINNER and nothing else, and Save here is not a native submit, so a typed or pasted
   * value goes to the API with the browser silent about it — the same gap the
   * credits-per-rand `step` fell through, where the field looked fine while the arrows moved
   * the money conversion rate by a hundredth.
   */
  it("holds Save and names the bound when a value is typed past the range", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await screen.findByLabelText(/Unlock time/), { target: { value: "45" } });
    expect(screen.getByText("Unlock time has to be a whole number of seconds between 1 and 30.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save settings/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PUT")).toBe(false));

    // And zero, which is the other end and the one that reads as broken hardware: a door
    // that never releases the lock at all.
    fireEvent.change(screen.getByLabelText(/Unlock time/), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: /Save settings/ })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Unlock time/), { target: { value: "30" } });
    expect(screen.getByRole("button", { name: /Save settings/ })).toBeEnabled();
  });

  it("holds Save on an early-entry value past 240 minutes, and allows 0", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await screen.findByLabelText(/Early entry/), { target: { value: "300" } });
    expect(screen.getByText("Early entry has to be a whole number of minutes between 0 and 240.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save settings/ })).toBeDisabled();

    // Zero is legal — a club that wants nobody in before their booking starts — so it must
    // not be caught by a falsy check standing in for the range.
    fireEvent.change(screen.getByLabelText(/Early entry/), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: /Save settings/ })).toBeEnabled();
  });

  /**
   * A refused save now decodes through the shared device-error dictionary instead of this
   * screen's old underscores-to-spaces swap, which would have read "gate unlock seconds out
   * of range" and said nothing about the bound.
   */
  it("turns a refused door value into a sentence with the bound in it", async () => {
    stubFetch([
      { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
      { path: "/api/v1/admin/courts/", body: [] },
      { method: "PUT", path: "/api/v1/admin/settings/", status: 400, body: { error: "gate_unlock_seconds_out_of_range" } },
    ]);
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await screen.findByLabelText(/Unlock time/), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

    expect(await screen.findByText(/Unlock time has to be between 1 and 30 seconds/))
      .toHaveTextContent(/never holds the lock open longer than 30 seconds/);
  });

  /**
   * And the fallback is unchanged for every token nobody has written copy for, which is what
   * makes switching this screen to the shared dictionary safe rather than a rewrite of how it
   * reports failure.
   */
  it("still reads an unmapped refusal the way it always did", async () => {
    stubFetch([
      { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
      { path: "/api/v1/admin/courts/", body: [] },
      { method: "PUT", path: "/api/v1/admin/settings/", status: 400, body: { error: "topup_max_below_block" } },
    ]);
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await screen.findByLabelText(/Top-up cap per member/), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

    expect(await screen.findByText(/topup max below block/)).toBeInTheDocument();
  });

  /**
   * A policy the client does not know about, which is a settings document written by
   * something else — an older or newer API, or a hand-edited JSON column. Caught before Save
   * rather than rendered as a blank select and then saved back as one.
   */
  it("refuses to save a policy it cannot render", async () => {
    const stub = stubFetch(routes({ gate_access_policy: "anyone_at_all" }));
    renderPage(<AdminSettingsPage />);

    expect(await screen.findByText("Pick who may open a door.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save settings/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PUT")).toBe(false));

    fireEvent.change(screen.getByLabelText(/Who may open a door/), { target: { value: "booking_window" } });
    expect(screen.getByRole("button", { name: /Save settings/ })).toBeEnabled();
  });
});
