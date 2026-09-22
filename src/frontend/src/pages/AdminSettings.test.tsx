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
      (field.getAttribute("aria-describedby") ?? "")
      .split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");

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
    //
    // TWICE, deliberately (B5 / C11): on the row that carries the mistake, and again in the
    // summary beside Save, which is six cards below it.
    expect(screen.getAllByText(/Closing time has to be after opening time/)).toHaveLength(2);
    // `aria-disabled`, not `disabled`: a disabled button leaves the tab order, so the one
    // control that could explain the state was the one a keyboard user could not reach.
    expect(screen.getByRole("button", { name: /Save settings/ })).toHaveAttribute("aria-disabled", "true");

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
    (field.getAttribute("aria-describedby") ?? "")
      .split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");

  it("shows the three door settings with the API's own bounds on the inputs", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const unlock = await screen.findByLabelText(/Unlock time/);
    // Ruling 5 / GOAL item 2: the shipping default moved from 3 seconds to 15, because three
    // is not long enough to get a door open while holding a bag. The BOUNDS are unchanged —
    // the firmware still caps the lock at 30 seconds whatever is set here.
    expect(unlock).toHaveValue(15);
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
   * The hint follows the policy that is selected, and the staff exemption appears on the one
   * arm where it exempts somebody from something.
   *
   * <p>
   * It used to read "accounts with no membership of their own, such as club admins and
   * operators, always pass", on both arms. The rule is `User.IsAdmin`; there is no operator
   * role in this product; and under the open policy every active member already passes, so
   * printing it there exempted nobody — while being false of a club admin whose own
   * membership is suspended, who is barred like anybody else.
   * </p>
   */
  it("describes the policy that is actually selected, and exempts admins only where it matters", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const picker = await screen.findByLabelText(/Who may open a door/);
    expect(hintOf(picker)).toMatch(/unless their membership is suspended, pending approval or rejected/);
    // No exemption on the open policy, and the word "operator" nowhere on the screen.
    expect(hintOf(picker)).not.toMatch(/always pass/);
    expect(hintOf(picker).toLowerCase()).not.toMatch(/operator/);

    fireEvent.change(picker, { target: { value: "booking_window" } });
    // The hint follows the choice rather than describing both at once, and it spells out the
    // early-entry number rather than making an admin scroll and do arithmetic.
    expect(hintOf(screen.getByLabelText(/Who may open a door/)))
      .toMatch(/starts within the next 30 minutes/);
    expect(hintOf(screen.getByLabelText(/Who may open a door/))).toMatch(/Anyone else is turned away/);
    // The exemption, and the limit on it in the same breath.
    expect(hintOf(screen.getByLabelText(/Who may open a door/)))
      .toMatch(/Club admins always pass this booking check/);
    expect(hintOf(screen.getByLabelText(/Who may open a door/)))
      .toMatch(/still turns anyone away, admin or not/);
    expect(hintOf(screen.getByLabelText(/Who may open a door/)).toLowerCase()).not.toMatch(/operator/);
  });

  /**
   * <b>A booking code is not a standing building key</b>, and the open policy's name implies
   * that it is. A member's own code opens a door at any hour under `active_member`; the QR
   * behind a booking opens one only inside that booking's own window, and not once the
   * booking is cancelled. Nothing else on this screen would tell an admin so.
   */
  it("says a booking's QR is narrower than a member's own code", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const hint = hintOf(await screen.findByLabelText(/Who may open a door/));
    expect(hint).toMatch(/own code scans opens the door at any hour/);
    expect(hint).toMatch(/A booking's QR is narrower/);
    expect(hint).toMatch(/only while that code is still live/);
    expect(hint).toMatch(/A cancelled booking's code opens nothing/);
    // The one bound that is the same for every club, and the reason "about the time the
    // phone shows it" is safe to print at all: without it the sentence is unbounded, and a
    // club whose roster reach and lights cue exceed four hours would read it as the truth.
    expect(hint).toMatch(/never more than four hours before the booking/);
  });

  /**
   * <b>A member who is late is not locked out of the building by the no-show sweep.</b> The
   * strict arm used to end at "and has not yet ended", which reads as — and, under the old
   * status rule, was — the front door shutting on somebody at the stroke of their slot's end.
   */
  it("says arriving late is not a lockout, under both policies", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const picker = await screen.findByLabelText(/Who may open a door/);
    expect(hintOf(picker)).toMatch(/Arriving late is not a lockout/);
    expect(hintOf(picker)).toMatch(/no-show sweep does not take that code away/);

    fireEvent.change(picker, { target: { value: "booking_window" } });
    const strict = hintOf(screen.getByLabelText(/Who may open a door/));
    expect(strict).toMatch(/Arriving late is not a lockout/);
    expect(strict).toMatch(/whose code for that booking is still live/);
    expect(strict).not.toMatch(/has not yet ended/);
  });

  /**
   * <b>The admin carve-out's third limit, in the carve-out's own sentence.</b> A cut-off door
   * decides from a cached roster built from bookings; there is no admin flag anywhere in it,
   * so the one person a club is most certain can always get in is refused at a door that has
   * lost the network.
   */
  it("bounds the admin carve-out to a door that can reach the club", async () => {
    stubFetch(routes({ gate_access_policy: "booking_window" }));
    renderPage(<AdminSettingsPage />);

    const hint = hintOf(await screen.findByLabelText(/Who may open a door/));
    const sentence = hint.split(". ").find((s) => s.includes("Club admins always pass"))!;
    expect(sentence).toContain("only at a door that can still reach the club");
    expect(sentence).toContain("an offline door holds bookings, not admins");
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
    expect(block).toHaveTextContent("falls back to the list of bookings it last downloaded");
    expect(block).toHaveTextContent("that list holds bookings and nothing else");
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
    // On the field itself, through aria-describedby — not only at the foot of the card,
    // where a screen reader moving field by field never meets it (B5).
    expect(hintOf(screen.getByLabelText(/Unlock time/)))
      .toContain("Unlock time has to be a whole number of seconds between 1 and 30.");
    expect(screen.getByLabelText(/Unlock time/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: /Save settings/ })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PUT")).toBe(false));

    // And zero, which is the other end and the one that reads as broken hardware: a door
    // that never releases the lock at all.
    fireEvent.change(screen.getByLabelText(/Unlock time/), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: /Save settings/ })).toHaveAttribute("aria-disabled", "true");

    fireEvent.change(screen.getByLabelText(/Unlock time/), { target: { value: "30" } });
    expect(screen.getByRole("button", { name: /Save settings/ })).not.toHaveAttribute("aria-disabled");
  });

  it("holds Save on an early-entry value past 240 minutes, and allows 0", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await screen.findByLabelText(/Early entry/), { target: { value: "300" } });
    expect(hintOf(screen.getByLabelText(/Early entry/)))
      .toContain("Early entry has to be a whole number of minutes between 0 and 240.");
    expect(screen.getByRole("button", { name: /Save settings/ })).toHaveAttribute("aria-disabled", "true");

    // Zero is legal — a club that wants nobody in before their booking starts — so it must
    // not be caught by a falsy check standing in for the range.
    fireEvent.change(screen.getByLabelText(/Early entry/), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: /Save settings/ })).not.toHaveAttribute("aria-disabled");
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
    expect(hintOf(screen.getByLabelText(/Who may open a door/))).toContain("Pick who may open a door.");
    expect(screen.getByRole("button", { name: /Save settings/ })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PUT")).toBe(false));

    fireEvent.change(screen.getByLabelText(/Who may open a door/), { target: { value: "booking_window" } });
    expect(screen.getByRole("button", { name: /Save settings/ })).not.toHaveAttribute("aria-disabled");
  });

  /**
   * <b>The number the screen was wrong about, now computed and printed.</b>
   *
   * <p>
   * At the API's own defaults — `active_member`, early entry 30, roster reach 120, lights cue
   * 10 — a booking QR opens a door 130 minutes out, and this screen said 30. Nothing on it
   * pointed at the two fields that actually decide it, and both of those are filed under a
   * heading that says "Court boxes". An admin lowering "Early entry" to narrow the door
   * narrowed nothing and was told "Settings saved."
   * </p>
   */
  it("shows the horizon a booking QR really opens a door in, not the early-entry number", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    // 120 + 10, not the 30 in the field directly above it.
    expect(await screen.findByText(
      "With these settings a booking QR opens a door from 130 minutes before the booking.",
    )).toBeInTheDocument();
    expect(screen.getByLabelText(/Early entry/)).toHaveValue(30);
  });

  /** And it follows every one of the three fields that feed it, live. */
  it("recomputes the horizon from whichever of the three fields is edited", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    await screen.findByText(/booking QR opens a door from 130 minutes/);

    // The lights cue, which is on the Court boxes block and reaches the doors.
    fireEvent.change(screen.getByLabelText(/Lights on this early/), { target: { value: "40" } });
    expect(screen.getByText(/booking QR opens a door from 160 minutes/)).toBeInTheDocument();

    // The roster reach, same block, same effect.
    fireEvent.change(screen.getByLabelText(/Offline roster reach/), { target: { value: "60" } });
    expect(screen.getByText(/booking QR opens a door from 100 minutes/)).toBeInTheDocument();

    // Early entry is the FLOOR, so raising it past the pair moves the answer and lowering it
    // below them does not — which is the half an admin cannot guess.
    fireEvent.change(screen.getByLabelText(/Early entry/), { target: { value: "200" } });
    expect(screen.getByText(/booking QR opens a door from 200 minutes/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Early entry/), { target: { value: "5" } });
    expect(screen.getByText(/booking QR opens a door from 100 minutes/)).toBeInTheDocument();
  });

  /** The cap, which is the answer an admin is most likely to be surprised by. */
  it("stops the horizon at four hours however wide the two court windows are", async () => {
    stubFetch(routes({ roster_window_minutes: 1440, activation_cue_window_minutes: 1440 }));
    renderPage(<AdminSettingsPage />);

    expect(await screen.findByText(/booking QR opens a door from 240 minutes/)).toBeInTheDocument();
  });

  /** Under the strict policy the two court windows drop out of it entirely. */
  it("reads the horizon off early entry alone under the strict policy", async () => {
    stubFetch(routes({ gate_access_policy: "booking_window", gate_early_entry_minutes: 45 }));
    renderPage(<AdminSettingsPage />);

    expect(await screen.findByText(/booking QR opens a door from 45 minutes/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Offline roster reach/), { target: { value: "1440" } });
    expect(screen.getByText(/booking QR opens a door from 45 minutes/)).toBeInTheDocument();
  });

  /**
   * <b>The early-entry hint says what the number governs under the policy that is selected.</b>
   * It used to say "How long before a booking starts its holder may come in" under both, which
   * is the door under one of them and the offline roster plus a floor under the other.
   */
  it("changes what the early-entry hint claims when the policy changes", async () => {
    stubFetch(routes({ gate_access_policy: "booking_window" }));
    renderPage(<AdminSettingsPage />);

    const strict = hintOf(await screen.findByLabelText(/Early entry/));
    expect(strict).toMatch(/Under the policy above this is the door/);
    expect(strict).toMatch(/cached roster reaches exactly that far/);

    fireEvent.change(screen.getByLabelText(/Who may open a door/), { target: { value: "active_member" } });
    const open = hintOf(screen.getByLabelText(/Early entry/));
    expect(open).toMatch(/the offline list and the floor/);
    expect(open).toMatch(/never opens a door less early than this/);
    // And it names the two fields that decide the rest, by the labels they carry on screen.
    expect(open).toMatch(/Offline roster reach/);
    expect(open).toMatch(/Lights on this early/);
    expect(open).not.toMatch(/Under the policy above this is the door/);
    // The bound is still on the hint: the field's own min/max stop the spinner and nothing else.
    expect(open).toMatch(/0–240/);
  });

  /**
   * <b>And the two court-side fields say they reach the doors.</b>
   *
   * <p>
   * They are filed under "Court boxes", they are named for courts, and under the default
   * policy they are two thirds of what decides when a booking QR opens a door. An admin
   * raising the roster reach to give the boxes a longer outage cushion widened every door in
   * the club by the same amount, and neither field said so.
   * </p>
   */
  it("says on both court-side fields that they also decide how early a door opens", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    for (const label of [/Lights on this early/, /Offline roster reach/]) {
      const hint = hintOf(await screen.findByLabelText(label));
      expect(hint).toMatch(/also decides how early a booking's QR opens a door/);
      expect(hint).toMatch(/capped at 240 minutes/);
    }

    // And the opposite under the strict policy, rather than going silent — with the field that
    // took over named, so an admin is not left looking for it.
    fireEvent.change(screen.getByLabelText(/Who may open a door/), { target: { value: "booking_window" } });
    for (const label of [/Lights on this early/, /Offline roster reach/]) {
      const hint = hintOf(screen.getByLabelText(label));
      expect(hint).toMatch(/does not reach the doors/);
      expect(hint).toMatch(/“Early entry” under Door gates does that/);
    }
  });
});

/**
 * <b>The alert cooldown.</b>
 *
 * <p>
 * A board that goes quiet used to mail the club on every sweep, and re-enabling a board that
 * had been off for a month mailed "back after 43 200 minutes". The setting bounds the first
 * of those. It is filed with the device numbers rather than in the door block because it
 * covers court boxes as well as doors — a box that goes quiet flaps exactly as a door does.
 * </p>
 */
describe("AdminSettings — alert cooldown", () => {
  afterEach(() => vi.unstubAllGlobals());

  const routes = (settings: Record<string, unknown> = {}) => [
    { path: "/api/v1/admin/settings/", body: { ...SETTINGS_FIXTURE, ...settings } },
    { path: "/api/v1/admin/courts/", body: [] },
    { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
  ];

  const hintOf = (field: HTMLElement) =>
    (field.getAttribute("aria-describedby") ?? "")
      .split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");

  it("shows the cooldown with the API's bounds, beside the device numbers", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const field = await screen.findByLabelText(/Alert cooldown/);
    expect(field).toHaveValue(60);
    expect(field).toHaveAttribute("min", "5");
    expect(field).toHaveAttribute("max", "1440");

    // It belongs to the boards, not to the doors: it is inside the Court boxes card, which is
    // where an admin looking for "why am I being mailed about this box" would go.
    expect(field.closest("div.space-y-5")).toHaveTextContent("Court boxes & identification");
  });

  /**
   * Both halves of what it does, because either alone leaves an admin with a wrong model: the
   * cooldown bounds the mail, and a door nobody has named is never mailed about at all —
   * which is not a failure of the cooldown and must not be read as one.
   */
  it("says what it bounds and which board it never mails about", async () => {
    stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    const hint = hintOf(await screen.findByLabelText(/Alert cooldown/));
    expect(hint).toMatch(/At most one “not reporting” email per board in this many minutes/);
    expect(hint).toMatch(/a door nobody has named never alerts/);
    expect(hint).toMatch(/5–1440/);
  });

  it("sends it on save, camelCase like the rest of the numbers", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await screen.findByLabelText(/Alert cooldown/), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

    await waitFor(() => {
      const save = stub.calls.find((c) => c.method === "PUT");
      expect(save).toBeTruthy();
      expect(save!.body).toMatchObject({ deviceAlertCooldownMinutes: 15 });
    });
  });

  /**
   * The input's bounds stop the spinner and nothing else, and Save is not a native submit —
   * the same gap the credits-per-rand `step` fell through. The lower end is the one that
   * matters: a cooldown of one minute is a club mailed once a sweep for as long as a board is
   * unplugged, which is the flapping the setting exists to stop.
   */
  it("holds Save and names the bound when a value is typed past the range", async () => {
    const stub = stubFetch(routes());
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await screen.findByLabelText(/Alert cooldown/), { target: { value: "1" } });
    expect(hintOf(screen.getByLabelText(/Alert cooldown/)))
      .toContain("Alert cooldown has to be a whole number of minutes between 5 and 1440.");
    expect(screen.getByLabelText(/Alert cooldown/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: /Save settings/ })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PUT")).toBe(false));

    fireEvent.change(screen.getByLabelText(/Alert cooldown/), { target: { value: "5" } });
    expect(screen.getByRole("button", { name: /Save settings/ })).not.toHaveAttribute("aria-disabled");
  });

  /** The refusal, decoded through the shared dictionary rather than the underscore swap. */
  it("turns a refused cooldown into a sentence with the bound in it", async () => {
    stubFetch([
      { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
      { path: "/api/v1/admin/courts/", body: [] },
      {
        method: "PUT", path: "/api/v1/admin/settings/", status: 400,
        body: { error: "device_alert_cooldown_minutes_out_of_range" },
      },
    ]);
    renderPage(<AdminSettingsPage />);

    fireEvent.change(await screen.findByLabelText(/Alert cooldown/), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));

    expect(await screen.findByText(/Alert cooldown has to be between 5 and 1440 minutes/))
      .toHaveTextContent(/one “not reporting” email per board/);
    expect(screen.queryByText(/device alert cooldown minutes out of range/)).not.toBeInTheDocument();
  });

  // --- doors: admin — W1's five tenant settings (WIRE-W1 section 6) --------------

  describe("the door records block", () => {
    const DOORS = {
      door_log_retention_days: 90,
      door_refusal_spike_count: 8,
      door_refusal_spike_minutes: 20,
      club_contact_phone: "076 226 1390",
      club_contact_email: "squash@example.co.za",
    };

    const withDoors = (overrides: Record<string, unknown> = {}) => [
      { path: "/api/v1/admin/settings/", body: { ...SETTINGS_FIXTURE, ...DOORS, ...overrides } },
      { path: "/api/v1/admin/courts/", body: [] },
    ];

    it("puts all five on the screen, each labelled and each with its range in a hint", async () => {
      stubFetch(withDoors());
      renderPage(<AdminSettingsPage />);

      expect(await screen.findByLabelText(/Keep door scans for/)).toHaveValue(90);
      expect(screen.getByLabelText(/Refusal spike \(scans\)/)).toHaveValue(8);
      expect(screen.getByLabelText(/Refusal spike window/)).toHaveValue(20);
      expect(screen.getByLabelText(/Club contact number/)).toHaveValue("076 226 1390");
      expect(screen.getByLabelText(/Club contact email/)).toHaveValue("squash@example.co.za");

      // Each hint names its own bound, through aria-describedby rather than by proximity.
      const retention = screen.getByLabelText(/Keep door scans for/);
      const hint = document.getElementById(retention.getAttribute("aria-describedby")!);
      expect(hint).toHaveTextContent("7–730");
      expect(hint).toHaveTextContent("DELETED");
    });

    /** The consequence in the club's own words, so a number is not just a number. */
    it("states what the retention number means in the words the log prints", async () => {
      stubFetch(withDoors());
      renderPage(<AdminSettingsPage />);

      expect(await screen.findByText(/Door scans are kept for 90 days and then deleted/))
        .toHaveTextContent("Money records follow a separate, longer rule.");
    });

    it("moves with the field, so an admin sees what they are choosing before Save", async () => {
      stubFetch(withDoors());
      renderPage(<AdminSettingsPage />);

      fireEvent.change(await screen.findByLabelText(/Keep door scans for/), { target: { value: "8" } });
      expect(screen.getByText(/kept for 8 days and then deleted/)).toBeInTheDocument();
    });

    /**
     * A number input's min and max stop the spinner and nothing else — a typed or pasted
     * value passes straight through, and Save here is not a native submit, so the browser
     * never says a word. The same gap the credits-per-rand `step` fell through.
     */
    it("refuses an out-of-range number here rather than at the API", async () => {
      stubFetch(withDoors());
      renderPage(<AdminSettingsPage />);

      fireEvent.change(await screen.findByLabelText(/Keep door scans for/), { target: { value: "3" } });
      // On the field, through aria-describedby — and again in the summary beside Save, which
      // is why the page-wide text now matches twice (B5 / C11).
      expect(hintOf(screen.getByLabelText(/Keep door scans for/))).toMatch(/between 7 and 730/);
      expect(screen.getAllByText(/between 7 and 730/)).toHaveLength(2);
      expect(screen.getByRole("button", { name: "Save settings" })).toHaveAttribute("aria-disabled", "true");
    });

    it("refuses a spike count and a window outside their own bounds", async () => {
      stubFetch(withDoors());
      renderPage(<AdminSettingsPage />);

      fireEvent.change(await screen.findByLabelText(/Refusal spike \(scans\)/), { target: { value: "1" } });
      expect(hintOf(screen.getByLabelText(/Refusal spike \(scans\)/))).toMatch(/between 3 and 100/);

      fireEvent.change(screen.getByLabelText(/Refusal spike \(scans\)/), { target: { value: "8" } });
      fireEvent.change(screen.getByLabelText(/Refusal spike window/), { target: { value: "1" } });
      expect(hintOf(screen.getByLabelText(/Refusal spike window/))).toMatch(/between 5 and 240/);
    });

    /**
     * <b>An empty contact is a real state, not a refusal.</b> A club that has not recorded a
     * phone number is exactly what the door card and the member's refusal card have copy
     * for, and refusing to save an empty one would make "no contact" impossible to express.
     */
    it("saves an empty club contact rather than refusing it", async () => {
      const stub = stubFetch([
        ...withDoors(),
        { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
      ]);
      renderPage(<AdminSettingsPage />);

      fireEvent.change(await screen.findByLabelText(/Club contact number/), { target: { value: "" } });
      expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

      await waitFor(() => {
        const put = stub.calls.find((c) => c.method === "PUT");
        expect(put?.body).toMatchObject({ clubContactPhone: "" });
      });
    });

    /** Both spellings bind at the API; camelCase is what every other number here sends. */
    it("sends every door key camelCase", async () => {
      const stub = stubFetch([
        ...withDoors(),
        { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
      ]);
      renderPage(<AdminSettingsPage />);

      fireEvent.click(await screen.findByRole("button", { name: "Save settings" }));

      await waitFor(() => {
        const put = stub.calls.find((c) => c.method === "PUT");
        expect(put?.body).toMatchObject({
          doorLogRetentionDays: 90,
          doorRefusalSpikeCount: 8,
          doorRefusalSpikeMinutes: 20,
          clubContactPhone: "076 226 1390",
          clubContactEmail: "squash@example.co.za",
        });
      });
    });

    /**
     * <b>An absent key is not a complaint, and not a field either.</b> An older API that does
     * not serve these leaves them undefined; omitted means unchanged on the way back, so
     * there is nothing to refuse — and an input bound to undefined is an uncontrolled field
     * that would report a save of a value nobody typed.
     */
    it("renders nothing and refuses nothing when the API does not serve the keys", async () => {
      stubFetch([
        { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
        { path: "/api/v1/admin/courts/", body: [] },
      ]);
      renderPage(<AdminSettingsPage />);

      await screen.findByLabelText(/Unlock time/);
      expect(screen.queryByLabelText(/Keep door scans for/)).toBeNull();
      expect(screen.queryByLabelText(/Club contact number/)).toBeNull();
      expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
      // And the retention sentence takes its no-number arm rather than guessing 90.
      expect(screen.getByText(/the number of days set under Admin settings/)).toBeInTheDocument();
    });
  });
});
