import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { AdminDevicesPage } from "./AdminDevices";
import {
  COURTS_FIXTURE,
  DEVICE_API_KEY_FIXTURE,
  SETTINGS_FIXTURE,
  deviceFixture,
  renderPage,
  stubFetch,
} from "../test/harness";

/**
 * The Devices screen, under the hobby-grade device contract.
 *
 * <p>
 * The screen this replaces managed a per-device key each box was issued once: a discovery
 * listener, a claim code read off an LCD, rotate, revoke and re-claim. All of that is
 * gone. One static key per club goes into every box's secrets.h, and a box that presents
 * it with an unknown device code registers itself on its first heartbeat.
 * </p>
 *
 * <p>
 * So these tests are about three things: can an admin actually get the key (masked,
 * revealed, copied, regenerated behind a confirm that says what it costs), does a box
 * that registered itself say so loudly enough that somebody checks its courts, and do
 * edit and delete send what the API binds.
 * </p>
 *
 * <p>
 * A court box drives up to four courts, one per relay, so "which court is this box for"
 * is a list, `court_numbers`, indexed A–D. It is snake_case on every request because the
 * API pins that name.
 * </p>
 */
describe("AdminDevices", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const baseRoutes = () => [
    { path: "/api/v1/admin/devices/api-key", body: DEVICE_API_KEY_FIXTURE },
    { path: "/api/v1/admin/devices/", body: [] },
    { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
    { path: "/api/v1/admin/courts/", body: COURTS_FIXTURE },
  ];

  /** The base routes with the device list replaced — the shape most tests want. */
  const withDevices = (body: unknown[]) => [
    ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
    { path: "/api/v1/admin/devices/", body },
  ];

  // --- the club's device API key -----------------------------------------------

  it("masks the device key until it is revealed, and copies the whole thing either way", async () => {
    stubFetch(baseRoutes());
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    renderPage(<AdminDevicesPage />);

    // Masked at rest: the ends are kept so an admin can tell one key from another
    // without putting the whole secret on a projector.
    const field = await screen.findByLabelText("Device API key");
    expect(field).toHaveTextContent("crsd••••••••a1c2");
    expect(field).not.toHaveTextContent(DEVICE_API_KEY_FIXTURE.api_key);

    // Copy takes the real key, not what is on screen — that is the whole point of
    // being able to copy a masked value.
    fireEvent.click(screen.getByRole("button", { name: "Copy device API key" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(DEVICE_API_KEY_FIXTURE.api_key));

    fireEvent.click(screen.getByRole("button", { name: "Reveal device API key" }));
    expect(screen.getByLabelText("Device API key")).toHaveTextContent(DEVICE_API_KEY_FIXTURE.api_key);

    // And it goes back. A key left revealed on a club laptop is the failure mode the
    // mask exists for.
    fireEvent.click(screen.getByRole("button", { name: "Hide device API key" }));
    expect(screen.getByLabelText("Device API key")).toHaveTextContent("crsd••••••••a1c2");
  });

  it("says when the key was last regenerated", async () => {
    stubFetch(baseRoutes());
    renderPage(<AdminDevicesPage />);

    // Not the ISO string. The question this answers is "is this from before or after
    // I flashed the boxes", and an admin cannot read that off a Z-suffixed timestamp.
    const line = await screen.findByText(/Last regenerated/);
    expect(line).not.toHaveTextContent("2026-09-01T08:30:00Z");
  });

  it("regenerates the key only behind a confirm that says every box must be reflashed", async () => {
    const next = { api_key: "crsdr_live_0000111122223333aaaa", regenerated_at: "2026-09-05T09:00:00Z" };
    const stub = stubFetch([
      ...baseRoutes(),
      { method: "POST", path: "/api/v1/admin/devices/api-key/regenerate", body: next },
    ]);

    renderPage(<AdminDevicesPage />);

    // The cost of this button is a physical trip to every box with a laptop, so the
    // armed label says so rather than asking "are you sure?".
    const regenerate = await screen.findByRole("button", { name: /Regenerate key/ });
    expect(screen.getByText(/old key stops working immediately/)).toBeInTheDocument();

    // First click arms, and sends nothing.
    fireEvent.click(regenerate);
    expect(stub.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(await screen.findByRole("button", { name: /Reflash every box after this/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Reflash every box after this/ }));

    await waitFor(() => {
      const post = stub.calls.find((c) => c.method === "POST");
      expect(post?.path).toBe("/api/v1/admin/devices/api-key/regenerate");
    });

    // The panel shows the NEW key, masked, without a reload.
    await waitFor(() => expect(screen.getByLabelText("Device API key")).toHaveTextContent("crsd••••••••aaaa"));
    expect(await screen.findByText(/New key issued/)).toHaveTextContent(/every box has to be reflashed/i);
  });

  it("explains a refused regeneration instead of silently keeping the old key on screen", async () => {
    stubFetch([
      ...baseRoutes(),
      { method: "POST", path: "/api/v1/admin/devices/api-key/regenerate", status: 500, body: { message: "Key store is unavailable." } },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Regenerate key/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Reflash every box after this/ }));

    // The failure mode this stops: a silent refusal, an admin who believes the key
    // rotated, and a fleet flashed with a key the API never issued.
    expect(await screen.findByText("Key store is unavailable.")).toBeInTheDocument();
    expect(screen.getByLabelText("Device API key")).toHaveTextContent("crsd••••••••a1c2");
  });

  it("says so when the key cannot be read at all, rather than showing an empty panel", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/api-key"),
      { path: "/api/v1/admin/devices/api-key", status: 500, body: { message: "boom" } },
    ]);

    renderPage(<AdminDevicesPage />);

    expect(await screen.findByText(/Could not read the club's device key/)).toBeInTheDocument();
    // No pairing instructions without a key to paste into them.
    expect(screen.queryByText(/How to pair a box/)).not.toBeInTheDocument();
  });

  it("tells an admin how to pair a box, including why a key is needed at all", async () => {
    stubFetch(baseRoutes());
    renderPage(<AdminDevicesPage />);

    expect(await screen.findByText(/How to pair a box/)).toBeInTheDocument();
    expect(screen.getByText(/secrets\.h/)).toBeInTheDocument();
    expect(screen.getByText(/make flash-bridge/)).toBeInTheDocument();
    expect(screen.getByText(/box-xxxxxx/)).toBeInTheDocument();
    // The topology nobody guesses: LAN for the box, tunnel for the app, which is why
    // "it is on our network" cannot be the box's identity.
    expect(screen.getByText(/club LAN/)).toHaveTextContent(/through the tunnel/);
  });

  // --- the removed contract ------------------------------------------------------

  it("no longer discovers, claims, registers, rotates or revokes anything", async () => {
    const stub = stubFetch(withDevices([deviceFixture()]));

    renderPage(<AdminDevicesPage />);
    await screen.findByText("Court 1 box");

    // The stub rejects any path it was not given, so a call to a removed endpoint
    // would already have failed the render. This pins the screen's controls too.
    for (const gone of [/Connect this board/i, /Claim/i, /Register/i, /Rotate/i, /Revoke/i, /Re-claim/i]) {
      expect(screen.queryByRole("button", { name: gone })).not.toBeInTheDocument();
    }
    // The OTA channel picker went with the firmware endpoints it drove.
    expect(screen.queryByLabelText(/update channel/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Code on the box/i)).not.toBeInTheDocument();
    for (const gone of ["discovered", "discovery-status", "claim", "rotate-key", "revoke", "firmware"]) {
      expect(stub.calls.some((c) => c.path.includes(gone))).toBe(false);
    }
  });

  // --- the fleet ------------------------------------------------------------------

  it("lists a connected board with its firmware and courts, relay by relay", async () => {
    stubFetch(withDevices([deviceFixture({ court_numbers: [1, 3] })]));

    renderPage(<AdminDevicesPage />);

    expect(await screen.findByText("Court 1 box")).toBeInTheDocument();
    // Relay order is the meaning: relay A drives court 1, relay B drives court 3.
    expect(screen.getByText(/A: court 1, B: court 3/)).toBeInTheDocument();
    expect(screen.getByText(/firmware 1\.0\.0/)).toBeInTheDocument();
  });

  it("shows a board that has not called in as offline", async () => {
    stubFetch(withDevices([deviceFixture({ last_seen_at: new Date(Date.now() - 10 * 60_000).toISOString() })]));

    renderPage(<AdminDevicesPage />);

    // A box in a cupboard that stopped talking is the thing an admin most needs to
    // see, and "last seen 10m ago" says it better than a red dot.
    expect(await screen.findByText(/last seen 10m ago/)).toBeInTheDocument();
  });

  /**
   * Review finding 22. "Offline" was a frozen 180 000 ms — three beats of a 30-second
   * cadence nothing had run for a while — while the settings page had grown an editable
   * interval offering up to 3600 s. An admin raising it to cut chatter watched every box
   * report WifiOff for most of every interval and started power-cycling working hardware
   * mid-league-night. The threshold is three beats of what the box actually runs.
   */
  it("decides offline from the club's heartbeat interval, not a fixed three minutes", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/" && r.path !== "/api/v1/admin/settings/"),
      { path: "/api/v1/admin/settings/", body: { ...SETTINGS_FIXTURE, heartbeat_seconds: 300 } },
      // Six minutes since the last beat. Two beats of a 300 s cadence: not an outage,
      // and the old fixed threshold called it one after three.
      { path: "/api/v1/admin/devices/", body: [deviceFixture({ last_seen_at: new Date(Date.now() - 6 * 60_000).toISOString() })] },
    ]);

    renderPage(<AdminDevicesPage />);

    expect(await screen.findByText("online")).toBeInTheDocument();
    expect(screen.queryByText(/last seen 6m ago/)).not.toBeInTheDocument();
  });

  it("takes the API's own offline threshold over any arithmetic of its own", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/" && r.path !== "/api/v1/admin/settings/"),
      { path: "/api/v1/admin/settings/", body: { ...SETTINGS_FIXTURE, heartbeat_seconds: 15 } },
      {
        path: "/api/v1/admin/devices/",
        // Ten minutes. Three beats of the club's 15 s setting would call this offline
        // twenty times over; the API says this box gets an hour, and the API is the
        // one that decides what a missed beat means.
        body: [deviceFixture({
          effective_heartbeat_seconds: 15,
          offline_after_seconds: 3600,
          last_seen_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        })],
      },
    ]);

    renderPage(<AdminDevicesPage />);

    expect(await screen.findByText("online")).toBeInTheDocument();
  });

  it("reads the interval the box reports over the club setting, because the box clamps its own", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/" && r.path !== "/api/v1/admin/settings/"),
      // The club asked for 600. The firmware clamps to 300 and says so; believing the
      // setting would give this box a twenty-minute grace it does not have.
      { path: "/api/v1/admin/settings/", body: { ...SETTINGS_FIXTURE, heartbeat_seconds: 600 } },
      {
        path: "/api/v1/admin/devices/",
        body: [deviceFixture({
          effective_heartbeat_seconds: 300,
          last_seen_at: new Date(Date.now() - 16 * 60_000).toISOString(),
        })],
      },
    ]);

    renderPage(<AdminDevicesPage />);

    expect(await screen.findByText(/last seen 16m ago/)).toBeInTheDocument();
  });

  /**
   * The tenant setting is a club's wish; the box's clamp is what happens. A club that
   * sets 600 has boxes calling in every 300, so the admin surface applies the same
   * 15-300 clamp before deciding anything from it.
   */
  it("clamps an out-of-range club setting the way the box does", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/" && r.path !== "/api/v1/admin/settings/"),
      { path: "/api/v1/admin/settings/", body: { ...SETTINGS_FIXTURE, heartbeat_seconds: 3600 } },
      // Twenty minutes. Under a believed 3600 s cadence this is barely a third of one
      // beat and would read online for three hours; under the real 300 s clamp it is
      // four missed beats and a box worth looking at.
      { path: "/api/v1/admin/devices/", body: [deviceFixture({ last_seen_at: new Date(Date.now() - 20 * 60_000).toISOString() })] },
    ]);

    renderPage(<AdminDevicesPage />);

    expect(await screen.findByText(/last seen 20m ago/)).toBeInTheDocument();
  });

  // --- self-registration ------------------------------------------------------------

  /**
   * A box arrives named `box-a1b2c3` driving whatever courts the API defaulted it to,
   * which are almost certainly the wrong ones. Nothing else on the screen distinguishes
   * that row from one an admin configured months ago, and the cost of missing it is a
   * league night with button 1 lighting the wrong court.
   */
  it("badges a box that registered itself, until somebody edits it", async () => {
    stubFetch(withDevices([
      deviceFixture({ id: "aaaa1111-1111-1111-1111-111111111111", device_code: "box-a1b2c3", name: "box-a1b2c3", auto_registered: true }),
      deviceFixture({ id: "bbbb2222-2222-2222-2222-222222222222", device_code: "court-box-2", name: "Court 2 box", auto_registered: false }),
    ]));

    renderPage(<AdminDevicesPage />);

    expect(await screen.findByText("New — check court numbers")).toBeInTheDocument();
    // One badge, on the one row that has not been looked at.
    expect(screen.getAllByText("New — check court numbers")).toHaveLength(1);
  });

  // --- edit -------------------------------------------------------------------------

  it("saves a box's name and courts together, in relay order", async () => {
    const stub = stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      { path: "/api/v1/admin/devices/", body: [deviceFixture({ name: "box-a1b2c3", auto_registered: true })] },
      { method: "PATCH", path: "/api/v1/admin/devices/", body: deviceFixture({ name: "Court 1 box", court_numbers: [1, 2] }) },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Edit name and courts/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Court 1 box" } });
    // The row's editor is labelled by the box, so two editors on one screen cannot be
    // confused for each other.
    expect(screen.getByLabelText("box-a1b2c3 relay A court")).toHaveValue("1");
    fireEvent.change(screen.getByLabelText("box-a1b2c3 relay B court"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /Save box/ }));

    await waitFor(() => {
      const patch = stub.calls.find((c) => c.method === "PATCH");
      expect(patch?.path).toBe("/api/v1/admin/devices/11111111-1111-1111-1111-111111111111");
      // Name and courts in one call: they are one job, and two calls would be two
      // chances to clear the "new" badge with half the work done.
      expect(patch?.body).toEqual({ name: "Court 1 box", court_numbers: [1, 2] });
    });
    expect(await screen.findByText(/now drives A: court 1, B: court 2/)).toBeInTheDocument();
  });

  it("clearing relay A clears the relays after it", async () => {
    stubFetch(withDevices([deviceFixture({ court_numbers: [1, 2] })]));

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Edit name and courts/ }));
    expect(screen.getByLabelText("Court 1 box relay B court")).toHaveValue("2");
    // A gap would be a relay index `court_numbers` cannot represent — it is positional
    // — so the editor makes one impossible rather than validating it away.
    fireEvent.change(screen.getByLabelText("Court 1 box relay A court"), { target: { value: "" } });
    expect(screen.getByLabelText("Court 1 box relay B court")).toHaveValue("");
    expect(screen.getByRole("button", { name: /Save box/ })).toBeDisabled();
  });

  it("turns court_number_not_found into a sentence", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      { path: "/api/v1/admin/devices/", body: [deviceFixture({ court_numbers: [1] })] },
      // The courts table is checked on update. The picker only offers real courts, so
      // this is a court deleted while the form was open.
      { method: "PATCH", path: "/api/v1/admin/devices/", status: 400, body: { error: "court_number_not_found" } },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Edit name and courts/ }));
    fireEvent.change(screen.getByLabelText("Court 1 box relay B court"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: /Save box/ }));

    // Not "court number not found" with the underscores swapped for spaces.
    expect(await screen.findByText(/not a court at this club/)).toHaveTextContent(/add it under Admin settings/);
    // And the editor stays open, since the save did not go through.
    expect(screen.getByRole("button", { name: /Save box/ })).toBeInTheDocument();
  });

  // --- delete -----------------------------------------------------------------------

  it("deletes a box behind a confirm that says it comes straight back", async () => {
    const stub = stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      { path: "/api/v1/admin/devices/", sequence: [[deviceFixture()], []], body: [] },
      { method: "DELETE", path: "/api/v1/admin/devices/", body: { deleted: true } },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));
    // Deleting is not a revocation — the box still holds the club's key. Saying so on
    // the armed button is what stops an admin believing they took a box off the network.
    const armed = await screen.findByRole("button", { name: /re-registers on its next heartbeat/ });
    expect(stub.calls.some((c) => c.method === "DELETE")).toBe(false);

    fireEvent.click(armed);

    await waitFor(() => {
      const del = stub.calls.find((c) => c.method === "DELETE");
      expect(del?.path).toBe("/api/v1/admin/devices/11111111-1111-1111-1111-111111111111");
    });
    expect(await screen.findByText(/still has the club's key, so it re-registers/)).toBeInTheDocument();
  });

  it("explains a refused delete", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      { path: "/api/v1/admin/devices/", body: [deviceFixture()] },
      { method: "DELETE", path: "/api/v1/admin/devices/", status: 409, body: { message: "That box has activations today." } },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));
    fireEvent.click(await screen.findByRole("button", { name: /re-registers on its next heartbeat/ }));

    expect(await screen.findByText("That box has activations today.")).toBeInTheDocument();
    expect(screen.getByText("Court 1 box")).toBeInTheDocument();
  });

  // --- button maps --------------------------------------------------------------------

  it("names the box when the button map reaches past its courts", async () => {
    stubFetch([
      ...baseRoutes(),
      {
        method: "PUT",
        path: "/api/v1/admin/settings/",
        status: 400,
        // What AdminConfigEndpoints returns: the token, plus which box and how far the
        // map reached. court_index 3 is relay D.
        body: { error: "button_map_selects_court_beyond_device_courts", device_code: "court-box-1", court_index: 3, device_court_count: 2 },
      },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.change(await screen.findByLabelText("Button 1 court"), { target: { value: "D" } });
    fireEvent.click(screen.getByRole("button", { name: /Save button map/ }));

    // The fix is on one of two screens, and the message says which box and which relay
    // so the admin does not have to work it out from a token.
    const toast = await screen.findByText(/selects court D, but court-box-1 drives only 2 courts/);
    expect(toast).toHaveTextContent(/Give the box more courts, or change the button map first/);
  });

  it("renders the button map as eight physical buttons", async () => {
    stubFetch(baseRoutes());
    renderPage(<AdminDevicesPage />);

    // Eight, always, whatever they now do — the index IS the physical button.
    expect(await screen.findByLabelText("Button 1 action")).toBeInTheDocument();
    expect(screen.getByLabelText("Button 8 action")).toBeInTheDocument();
    expect(screen.queryByLabelText("Button 9 action")).not.toBeInTheDocument();

    expect(screen.getByLabelText("Button 1 court")).toHaveValue("A");
    expect(screen.getByLabelText("Button 5 minutes")).toHaveValue(15);
  });

  /**
   * Review finding 23. This screen used to PUT the whole settings document it read at
   * mount, and this test asserted that as a feature — "everything else goes back
   * exactly as it was read". Replaying a value read minutes ago is not a no-op, it is a
   * write of a stale number: two admins on league night, one raising the code lifetime
   * in another tab, the other remapping a button, and the first change is gone with no
   * error anywhere. The API reads an ABSENT key as unchanged, so the fix is to send
   * only what this screen owns — and the assertion has to be absence, because a wrong
   * value and a stale-but-equal value look identical in a fixture.
   */
  it("sends only the button map and the required fields, so it cannot revert the settings screen", async () => {
    const stub = stubFetch([
      ...baseRoutes(),
      { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true } },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.change(await screen.findByLabelText("Button 1 court"), { target: { value: "D" } });
    fireEvent.click(screen.getByRole("button", { name: /Save button map/ }));

    await waitFor(() => {
      const save = stub.calls.find((c) => c.method === "PUT");
      expect(save).toBeTruthy();
      const body = save!.body as Record<string, unknown>;

      expect(body.buttonMap).toEqual(["court:D", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "minutes:60"]);

      // The eight the API refuses a PUT without. Not this screen's to change, but there
      // is no PATCH, so they are round-tripped and nothing else is.
      expect(body.sliceMinutes).toBe(15);
      expect(body.slicePriceCredits).toBe(8);
      expect(body.advanceBookingDays).toBe(14);
      expect(body.dayStartMinute).toBe(360);
      expect(body.dayEndMinute).toBe(1320);
      expect(body.penaltyPct).toBe(30);
      expect(body.graceWindowMinutes).toBe(5);
      expect(body.penaltyWindowMinutes).toBe(15);

      // The economics, and the six court-box numbers this screen grew a moment later:
      // absent, so the API leaves each of them exactly as it is. Checked against the
      // serialised body as well, because a key present as undefined and a key that was
      // never there parse to the same thing.
      for (const absent of [
        "creditsPerZarRegular", "creditsPerZarLeague", "topupBlockZar", "topupMaxZarPerMember",
        "memberPerDayMaxMinutes", "peakHours", "peakAdvanceHoursForRegular", "retentionYears",
        "noShowLookbackDays", "walkUpMaxMinutes", "heartbeatSeconds",
        "activationForwardWindowMinutes", "activationCueWindowMinutes", "qrLifetimeSeconds",
        "rosterWindowMinutes",
      ]) {
        expect(body).not.toHaveProperty(absent);
        expect(save!.raw).not.toContain(absent);
      }
    });
  });

  /**
   * A dropped lead from the round-3 review, verified: the editor's minutes field offered
   * up to 240 while `ButtonMap.MaxGrantMinutes` is the relay bank's own 90, pinned as
   * `relay_hard_cap_minutes` in the shared corpus and static-asserted on the firmware
   * side. Everything the extra range bought an admin was a save refused after the fact
   * — and, on a box that took the map, ninety minutes of light on a grant sold for more.
   */
  it("will not offer a button grant longer than the relay can deliver", async () => {
    stubFetch(baseRoutes());
    renderPage(<AdminDevicesPage />);

    const minutes = await screen.findByLabelText("Button 5 minutes");
    expect(minutes).toHaveAttribute("max", "90");
    expect(minutes).toHaveAttribute("min", "1");

    // A number input's max stops the spinner, not a typed or pasted value, so the
    // reason is said at the field and the save is held rather than round-tripped into
    // a refusal an admin has to decode.
    fireEvent.change(minutes, { target: { value: "240" } });
    expect(screen.getByText(/the relay cuts the lights at 90/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save button map/ })).toBeDisabled();

    fireEvent.change(minutes, { target: { value: "90" } });
    expect(screen.queryByText(/the relay cuts the lights at 90/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save button map/ })).toBeEnabled();
  });

  it("offers a box its own button map only when the API sends the field", async () => {
    stubFetch(withDevices([deviceFixture()]));

    renderPage(<AdminDevicesPage />);

    await screen.findByText("Court 1 box");
    // An API that does not send `button_map` gets no editor whose save would bind to nothing.
    expect(screen.queryByRole("button", { name: /Edit buttons/ })).not.toBeInTheDocument();
  });

  it("gives a box its own button map, sent as button_map", async () => {
    const stub = stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      { path: "/api/v1/admin/devices/", body: [deviceFixture({ button_map: null })] },
      { method: "PATCH", path: "/api/v1/admin/devices/", body: deviceFixture({ button_map: SETTINGS_FIXTURE.button_map }) },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Edit buttons/ }));
    // Null on the payload means the club's map; that is what is selected, and the
    // editor is not shown until the admin asks for an override.
    expect(screen.getByLabelText(/Use the club's button map/)).toBeChecked();
    expect(screen.queryByLabelText("Court 1 box button 1 action")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Own map for this box/));
    // The override starts from the club's map, labelled by the box so the two editors
    // on this screen cannot be confused.
    expect(screen.getByLabelText("Court 1 box button 1 court")).toHaveValue("A");
    fireEvent.change(screen.getByLabelText("Court 1 box button 1 court"), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: /Save buttons/ }));

    await waitFor(() => {
      const patch = stub.calls.find((c) => c.method === "PATCH");
      expect(patch?.path).toBe("/api/v1/admin/devices/11111111-1111-1111-1111-111111111111");
      expect(patch?.body).toEqual({ button_map: ["court:B", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "minutes:60"] });
    });
    expect(await screen.findByText(/has its own button map/)).toBeInTheDocument();
  });

  it("sends null to put a box back on the club's button map", async () => {
    const stub = stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      { path: "/api/v1/admin/devices/", body: [deviceFixture({ button_map: ["court:A", "off", "none", "none", "none", "none", "none", "none"] })] },
      { method: "PATCH", path: "/api/v1/admin/devices/", body: deviceFixture({ button_map: null }) },
    ]);

    renderPage(<AdminDevicesPage />);

    expect(await screen.findByText("own button map")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Edit buttons/ }));
    expect(screen.getByLabelText(/Own map for this box/)).toBeChecked();
    expect(screen.getByLabelText("Court 1 box button 2 action")).toHaveValue("off");

    fireEvent.click(screen.getByLabelText(/Use the club's button map/));
    fireEvent.click(screen.getByRole("button", { name: /Save buttons/ }));

    await waitFor(() => {
      const patch = stub.calls.find((c) => c.method === "PATCH");
      // Null, not an empty list: the API reads null as "the club's map".
      expect(patch?.body).toEqual({ button_map: null });
    });
  });

  it("leaves button_map out of a PATCH that does not touch it, and sends null only to clear it", async () => {
    const ownMap = ["court:A", "off", "none", "none", "none", "none", "none", "none"];
    const stub = stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      // A box WITH an override, so echoing it back would be the tempting mistake.
      { path: "/api/v1/admin/devices/", body: [deviceFixture({ court_numbers: [1], button_map: ownMap })] },
      { method: "PATCH", path: "/api/v1/admin/devices/", body: deviceFixture({ court_numbers: [1, 2], button_map: ownMap }) },
    ]);

    renderPage(<AdminDevicesPage />);

    // A name-and-courts change.
    fireEvent.click(await screen.findByRole("button", { name: /Edit name and courts/ }));
    fireEvent.change(screen.getByLabelText("Court 1 box relay B court"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /Save box/ }));
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "PATCH")).toHaveLength(1));

    // The API binds button_map three-valued — absent leaves the override alone, null
    // clears it, a list sets it — so a PATCH about something else must not carry the key
    // at all: not as null (that would clear the box's map), not as its current value
    // (a stale echo racing another admin's edit). Asserted on the wire text, because a
    // parsed object cannot tell "absent" from "present as undefined".
    const patches = stub.calls.filter((c) => c.method === "PATCH");
    expect(Object.keys(patches[0].body as object)).toEqual(["name", "court_numbers"]);
    expect(patches[0].raw).not.toContain("button_map");

    // And "club default" is a PATCH whose body is exactly `{"button_map":null}` — the
    // one value the API reads as "clear the override".
    fireEvent.click(await screen.findByRole("button", { name: /Edit buttons/ }));
    fireEvent.click(screen.getByLabelText(/Use the club's button map/));
    fireEvent.click(screen.getByRole("button", { name: /Save buttons/ }));
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    expect(stub.calls.filter((c) => c.method === "PATCH")[1].raw).toBe('{"button_map":null}');
  });
});
