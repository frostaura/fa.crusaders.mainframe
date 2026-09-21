import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { AdminDevicesPage } from "./AdminDevices";
import {
  COURTS_FIXTURE,
  DEVICE_API_KEY_FIXTURE,
  SETTINGS_FIXTURE,
  activityFixture,
  deviceFixture,
  deviceServer,
  gateFixture,
  renderPage,
  stubFetch,
} from "../test/harness";
import { clubInstant } from "../lib/clubClock";

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
    expect(await screen.findByRole("button", { name: /Reflash every board after this/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Reflash every board after this/ }));

    await waitFor(() => {
      const post = stub.calls.find((c) => c.method === "POST");
      expect(post?.path).toBe("/api/v1/admin/devices/api-key/regenerate");
    });

    // The panel shows the NEW key, masked, without a reload.
    await waitFor(() => expect(screen.getByLabelText("Device API key")).toHaveTextContent("crsd••••••••aaaa"));
    expect(await screen.findByText(/New key issued/)).toHaveTextContent(/every board, court boxes and door gates alike, has to be reflashed/i);
  });

  it("explains a refused regeneration instead of silently keeping the old key on screen", async () => {
    stubFetch([
      ...baseRoutes(),
      { method: "POST", path: "/api/v1/admin/devices/api-key/regenerate", status: 500, body: { message: "Key store is unavailable." } },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Regenerate key/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Reflash every board after this/ }));

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
    expect(screen.queryByText(/How to pair a board/)).not.toBeInTheDocument();
  });

  it("tells an admin how to pair a box, including why a key is needed at all", async () => {
    stubFetch(baseRoutes());
    renderPage(<AdminDevicesPage />);

    expect(await screen.findByText(/How to pair a board/)).toBeInTheDocument();
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
  // --- the page the outage email links to (finding M-F2) ----------------------------

  /**
   * The number of times the page has re-read the device list.
   *
   * `/api/v1/admin/devices/` is a prefix of `/api/v1/admin/devices/api-key`, so the count
   * has to exclude the key — the same trap the harness's longest-prefix routing exists for.
   */
  const deviceReads = (stub: { calls: { method: string; path: string }[] }) =>
    stub.calls.filter((c) => c.method === "GET" && c.path === "/api/v1/admin/devices/").length;

  /**
   * The M-F2 headline, as the finder measured it: a tab left open on this page read
   * "online" for a box that had been dark for six and a half minutes — more than double
   * the offline threshold, and long after the club had been emailed "court box not
   * reporting" with a link to this very page — while a second tab on the same URL, opened
   * two seconds later, read "last seen 6m ago".
   *
   * <p>
   * The clock is faked and nothing about the fixture changes: the same box, the same
   * `last_seen_at`, and the passage of time alone is what should move it from online to
   * silent. A page that renders once cannot do that.
   * </p>
   *
   * <p>
   * Rendered under StrictMode, as <code>src/main.tsx</code> renders the app. The
   * mount → cleanup → mount cycle is exactly what a `mounted`-ref guard round a poller
   * gets wrong, and two defects in this repo have come from that shape — the interval must
   * still be doing work after the second mount, which the exact read count below proves.
   * </p>
   *
   * <p>
   * <b>Via <code>reactStrictMode: true</code>, not a <code>&lt;StrictMode&gt;</code> element
   * inside the page.</b> Testing Library puts the option's wrapper OUTSIDE its own
   * <code>wrapper</code>, whereas <code>renderPage(&lt;StrictMode&gt;…&lt;/StrictMode&gt;)</code>
   * puts it inside the harness's providers — and there it double-invokes nothing at all.
   * Measured: a probe under <code>render(&lt;StrictMode&gt;…)</code> logs
   * mount → cleanup → mount, the same probe under
   * <code>renderPage(&lt;StrictMode&gt;…)</code> logs only mount. A test written the second
   * way looks like it is guarding against the StrictMode defects and is not.
   * </p>
   */
  it("keeps the liveness live on an open tab instead of freezing it at load", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const stub = stubFetch(withDevices([deviceFixture({ last_seen_at: new Date().toISOString() })]));

    renderPage(<AdminDevicesPage />, { reactStrictMode: true });
    // The initial load settles on microtasks, not on a timer.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("online")).toBeInTheDocument();

    const atLoad = deviceReads(stub);

    // Thirteen fifteen-second ticks — 195 s — past a 180 s threshold (three beats of the
    // club's 60 s heartbeat). Nothing else moves.
    for (let i = 0; i < 13; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    }

    expect(screen.queryByText("online")).not.toBeInTheDocument();
    expect(screen.getByText(/not reporting — last seen 3m ago/)).toBeInTheDocument();

    // And it is the poller doing it — one read per tick, all thirteen, still running long
    // after StrictMode's second mount. An exact count rather than "more than before":
    // advancing the clock re-renders the tree for other reasons too, and a row that
    // re-computes `isOnline` off the moved clock would otherwise satisfy the assertions
    // above with no poller behind them at all.
    expect(deviceReads(stub)).toBe(atLoad + 13);
    vi.useRealTimers();
  });

  it("says when it last looked, and looks again on demand", async () => {
    const stub = stubFetch(withDevices([deviceFixture()]));

    renderPage(<AdminDevicesPage />);

    // The sentence is a promise about behaviour, so it names the interval the page runs.
    //
    // Both assertions are made against the SAME element, found by the half that only
    // appears once the load has resolved. Split into a `findByText` on the interval
    // sentence followed by a synchronous `getByText(/^Checked /)`, this test failed about
    // one run in four: the interval sentence is rendered from first paint, while `Checked`
    // waits on `checkedAt`, so the find resolved against the pre-load render and the get
    // then ran against a paragraph still reading "Checking…".
    //
    // THREE lanes fixed this flake independently in round 8, which says more about the
    // finding than about the lanes. Two made both reads
    // `findByText`, which also removes the race — but leaves them free to resolve against
    // different elements at different moments, so it would still pass if the two sentences
    // drifted into separate paragraphs. One element, found by the slower half, is the form
    // that keeps proving what the test is named for.
    const status = await screen.findByText(/^Checked /);
    // "boards", not "boxes": a gate is on this list exactly as a box is, and a club that owns
    // only doors was being told this page re-reads something it does not have.
    expect(status).toHaveTextContent(/re-reads the boards every 15 seconds/);

    const atLoad = deviceReads(stub);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(deviceReads(stub)).toBe(atLoad + 1));
    // Only the boxes. Re-reading the settings on this button would fight the club button
    // map an admin may be part-way through editing on the same screen.
    expect(stub.calls.filter((c) => c.method === "GET" && c.path === "/api/v1/admin/settings/")).toHaveLength(1);
  });

  // --- taking a box out of service (finding M-F3) -----------------------------------

  /**
   * `Device.Enabled` has been on the API, on the typed client and in the settlement model
   * since the row existed, and no screen ever sent it. The consequences are not cosmetic:
   * `PeripheralHealthWorker` filters on it, so a box that is broken or unplugged for good
   * alerts the club every thirty seconds about a silence nobody can stop; and
   * `DeviceOutageIndex` builds its silence index from enabled boxes alone, so a court whose
   * only box is dead-but-enabled is "dark" for ever and every no-show on it is refunded
   * with no penalty. The only lever the page offered was Delete, which the page itself
   * describes as a reset.
   */
  it("takes a box out of service behind a confirm, and says what that costs", async () => {
    const stub = stubFetch([
      ...withDevices([deviceFixture()]),
      { method: "PATCH", path: "/api/v1/admin/devices/11111111-1111-1111-1111-111111111111", body: deviceFixture({ enabled: false }) },
    ]);

    renderPage(<AdminDevicesPage />);

    // Arms first: a live box stops switching lights on the moment this lands.
    const take = await screen.findByRole("button", { name: "Take out of service" });
    fireEvent.click(take);
    expect(stub.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);

    // And the confirm names the consequence an admin cannot see from the row: this is the
    // only box on court 1, so afterwards the API takes nothing from it and the sweep stops
    // charging the no-show penalty on that court from the instant of the click
    // (settlement-model.md S5a). The confirm used to say only "the box stops switching
    // lights on", which is the half that costs the CLUB nothing.
    const confirm = await screen.findByRole("button", { name: /Nothing else drives court 1/ });
    expect(confirm).toHaveAccessibleName(/no-shows stop being penalised/);
    fireEvent.click(confirm);

    await waitFor(() => expect(stub.calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    // Exactly the one field. Sending the name and courts alongside would rewrite whatever
    // another admin had just changed on this row.
    expect(stub.calls.find((c) => c.method === "PATCH")!.raw).toBe('{"enabled":false}');
  });

  it("shows an out-of-service box as that rather than as offline, and offers it back", async () => {
    const stub = stubFetch([
      ...withDevices([deviceFixture({ enabled: false, court_numbers: [1, 2] })]),
      { method: "PATCH", path: "/api/v1/admin/devices/11111111-1111-1111-1111-111111111111", body: deviceFixture() },
    ]);

    renderPage(<AdminDevicesPage />);

    // Not "offline": nobody expects it to call in, and showing it beside the boxes that
    // have genuinely gone quiet is how a club learns to ignore the state that matters.
    expect(await screen.findByText("out of service")).toBeInTheDocument();
    expect(screen.queryByText(/not reporting/)).not.toBeInTheDocument();

    // Every sentence is something the code does — the API refuses a disabled box, the
    // health sweep skips it, and a court left with no box in service is dark, so its
    // no-shows are refunded in full with no penalty.
    //
    // That last clause used to read "A: court 1, B: court 2 are judged by whatever other
    // boxes drive them", which in this state — the only box in the club — names nothing at
    // all, and an admin reads it as "something else covers it". It is the state where the
    // money moves.
    const notice = screen.getByText(/The API refuses this box, so it switches nothing on/);
    expect(notice).toHaveTextContent("not alerted about its silence");
    expect(notice).toHaveTextContent(
      "No box in service drives courts 1 and 2, so the API turns that hardware away");
    // Not "nobody can check in there", which this sentence claimed for three rounds. The 403
    // behind it is DeviceIdentity's and reaches the four /api/v1/device/ routes only; the
    // courtside PIN, QR and biometric match routes never read a Device row and do check a
    // member in. See lib/deviceCoverage.test.ts, which pins the absence over every arm.
    expect(notice).not.toHaveTextContent("nobody can check in there");
    expect(notice).toHaveTextContent(
      "The courtside PIN, QR and fingerprint terminal is a different machine and still checks members in there");
    // "them", not "it". The plural arm of this pronoun had never been executed by any test in
    // this repo — round 9's verifier forced the helper to return "it" always and both suites
    // stayed green, so the row could read "bookings on it" under a confirm reading "their".
    expect(notice).toHaveTextContent("Bookings on them nobody checks in on are refunded in full with no no-show penalty");
    // And when. Round 9 promised this from the click while the ledger delivered it
    // offline_after_seconds later — 180 s at the shipped 60 s cadence — so a grace deadline in
    // that window paid the 30% the screen had just waived. DoorWasShutFor now answers from
    // devices.OutOfServiceSince, and the sentence says so instead of leaving it to be assumed.
    expect(notice).toHaveTextContent("from the instant the switch was thrown until a box is back in service");
    expect(notice).not.toHaveTextContent("judged as normal");

    // Restoring is not a decision anyone regrets, so it is one tap.
    fireEvent.click(screen.getByRole("button", { name: "Put back in service" }));
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    expect(stub.calls.find((c) => c.method === "PATCH")!.raw).toBe('{"enabled":true}');
  });

  /**
   * The other side of the same sentence, and the reason it has to be computed per court
   * rather than written flat: a box whose courts ARE covered by another box in service
   * gets no warning at all, on the row and on the confirm.
   *
   * <p>
   * Court 2 is driven by a second box that is still in service; court 1 is not. So the
   * notice has to say both things about one row, and the confirm on the OTHER row — the
   * live box on court 2 alone — has to stay the plain one. Without this test the fix could
   * be "always warn", which is the same defect as "never warn" a fortnight later, when
   * admins have learned to click through it.
   * </p>
   */
  it("warns only about the courts a box actually strands, and not about the covered ones", async () => {
    stubFetch(withDevices([
      deviceFixture({ enabled: false, court_numbers: [1, 2] }),
      deviceFixture({
        id: "33333333-3333-3333-3333-333333333333",
        device_code: "court-box-2",
        name: "Court 2 box",
        court_numbers: [2],
      }),
    ]));

    renderPage(<AdminDevicesPage />);

    const notice = await screen.findByText(/The API refuses this box, so it switches nothing on/);
    expect(notice).toHaveTextContent("No box in service drives court 1, so the API turns that hardware away");
    expect(notice).toHaveTextContent("Bookings on it nobody checks in on are refunded in full with no no-show penalty");
    // And the court that is covered is named as covered, rather than swept into the same
    // sentence as the one that is not.
    // "still reporting on", not "still drive": a box that is in service but has gone quiet
    // drives nothing the settlement will believe in. See the silent-sibling test below.
    // "Another box", singular, because there is exactly one — this sentence said "Other boxes"
    // at every count until round 10, so the commonest shape in a four-box club was told there
    // were several. The full number matrix is in lib/deviceCoverage.test.ts.
    expect(notice).toHaveTextContent("Another box is still reporting on court 2, so its no-shows are judged as normal");

    // The live box is now the only thing in service on court 2 — the row above is out of
    // service and covers nothing — so its own confirm warns about court 2 and about
    // nothing else. (The out-of-service row offers "Put back in service", not a confirm,
    // so this is unambiguous.)
    fireEvent.click(screen.getByRole("button", { name: "Take out of service" }));
    expect(await screen.findByRole("button", { name: /Nothing else drives court 2/ })).toBeInTheDocument();
  });

  /**
   * The negative: two boxes in service on the same court, so taking either one out strands
   * nothing and the confirm stays the plain sentence.
   *
   * <p>
   * Without this the fix could be "always warn", which is the same defect as "never warn"
   * a fortnight later, once admins have learned to click through it.
   * </p>
   */
  it("keeps the plain confirm on a box whose courts another box in service also drives", async () => {
    stubFetch(withDevices([
      deviceFixture({ court_numbers: [2] }),
      deviceFixture({
        id: "33333333-3333-3333-3333-333333333333",
        device_code: "court-box-2",
        name: "Court 2 spare",
        court_numbers: [2],
      }),
    ]));

    renderPage(<AdminDevicesPage />);

    const confirms = await screen.findAllByRole("button", { name: "Take out of service" });
    expect(confirms).toHaveLength(2);
    for (const button of confirms) fireEvent.click(button);

    expect(screen.queryByRole("button", { name: /Nothing else drives/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /The box stops switching lights on/ })).toHaveLength(2);
  });

  /**
   * The toast is a fourth place the same promise is made, and it had none of its own test.
   *
   * <p>
   * It is generated from the same {@link outOfServiceConsequences} as the row notice, which is
   * the point: round 8 had the two saying different things about one click, and the toast is
   * the half an admin actually reads, because the row is behind it.
   * </p>
   */
  it("says in the toast exactly what the row says, for the courts the click strands", async () => {
    stubFetch([
      ...withDevices([deviceFixture()]),
      { method: "PATCH", path: "/api/v1/admin/devices/11111111-1111-1111-1111-111111111111", body: deviceFixture({ enabled: false }) },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Take out of service" }));
    fireEvent.click(await screen.findByRole("button", { name: /Nothing else drives court 1/ }));

    expect(await screen.findByText(
      "Court 1 box is out of service. It switches nothing on, and the club is not alerted about its silence."
      + " No box in service drives court 1, so the API turns that hardware away: no scan, walk-up or"
      + " activation from it reaches the club. The courtside PIN, QR and fingerprint terminal is a"
      + " different machine and still checks members in there. Bookings on it nobody checks in on are"
      + " refunded in full with no no-show penalty, from the instant the switch was thrown until a box"
      + " is back in service.",
    )).toBeInTheDocument();
  });

  /**
   * Both consequences at once, which is the only shape that exercises the joining of them —
   * and the only one where the second sentence has to say "too".
   */
  it("names a shut court and a quiet one separately when a box strands both", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    stubFetch(withDevices([
      deviceFixture({ court_numbers: [1, 2] }),
      deviceFixture({
        id: "33333333-3333-3333-3333-333333333333",
        device_code: "court-box-2",
        name: "Court 2 spare",
        court_numbers: [2],
        last_seen_at: threeHoursAgo,
      }),
    ]));

    renderPage(<AdminDevicesPage />);

    const confirms = await screen.findAllByRole("button", { name: "Take out of service" });
    fireEvent.click(confirms[0]);
    expect(await screen.findByRole("button", {
      // B5 — the armed control is no longer LABELLED by its consequence: the consequence is a
      // block of page text above two side-by-side buttons, and the confirm button shows the
      // words the trigger showed. WCAG 2.5.3 then makes its accessible name open with those
      // words, so the sentence this test is about is a SUFFIX of the name rather than the
      // whole of it. The sentence itself is unchanged and is still what is being held here.
      name: "Take out of service — Out of service? Nothing else drives court 1 — the API stops taking"
        + " anything from that box, and from that instant its no-shows stop being penalised. No other box"
        + " on court 2 is reporting, so its no-shows stop being penalised too.",
    })).toBeInTheDocument();
  });

  /**
   * R8V-R3. The covered sentence was false whenever the covering box had gone quiet.
   *
   * <p>
   * `DeviceOutageIndex.CourtWasDark` calls a court dark when every ENABLED box driving it was
   * past the offline threshold — enabled AND silent. This page tested `enabled` alone, so a
   * court whose only remaining box was in service but three hours quiet was reported as
   * covered. Round 8's verifier proved the money half on a live stack: with the spare in
   * service an identical settled booking got CancellationRefund 8.00 AND NoShowPenalty -2.40;
   * with the spare taken out, refund 8.00 and no penalty row at all. The click DID stop that
   * court being penalised, while the confirm showed the plain sentence and the row afterwards
   * said its no-shows were judged as normal.
   * </p>
   *
   * <p>
   * The club heartbeat is 60 s here, so the offline threshold is three beats — 180 s — and a
   * sibling last seen three hours ago is well past it. The page renders that sibling as "not
   * reporting" in its own header; the point of this test is that the sentence two lines below
   * agrees with the badge.
   * </p>
   */
  it("warns when the only other box on the court is in service but has stopped reporting", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    stubFetch(withDevices([
      deviceFixture({ name: "Court 2 spare", court_numbers: [2] }),
      deviceFixture({
        id: "33333333-3333-3333-3333-333333333333",
        device_code: "court-box-2",
        name: "Court 1 and 2 box",
        court_numbers: [1, 2],
        last_seen_at: threeHoursAgo,
      }),
    ]));

    renderPage(<AdminDevicesPage />);

    // The page already says the sibling is not reporting, in its own header.
    expect(await screen.findByText(/not reporting — last seen 3h ago/)).toBeInTheDocument();

    // Taking the one reporting box on court 2 out of service is what stops court 2's
    // no-shows being penalised, and the confirm now says so instead of the plain sentence.
    const confirms = screen.getAllByRole("button", { name: "Take out of service" });
    fireEvent.click(confirms[0]);
    expect(await screen.findByRole("button", {
      // B5 — the armed control is no longer LABELLED by its consequence: the consequence is a
      // block of page text above two side-by-side buttons, and the confirm button shows the
      // words the trigger showed. WCAG 2.5.3 then makes its accessible name open with those
      // words, so the sentence this test is about is a SUFFIX of the name rather than the
      // whole of it. The sentence itself is unchanged and is still what is being held here.
      name: "Take out of service — Out of service? No other box on court 2 is reporting, so its no-shows"
        + " stop being penalised.",
    })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /The box stops switching lights on/ })).not.toBeInTheDocument();
    // And not the stronger claim, which this page cannot support: a silent box may still be
    // answering the door. What is measurable is that nothing is reporting.
    expect(screen.queryByRole("button", { name: /nobody can check in/ })).not.toBeInTheDocument();
  });

  it("says on the row, too, that nothing in service is reporting on the court", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    stubFetch(withDevices([
      deviceFixture({ enabled: false, name: "Court 2 spare", court_numbers: [2] }),
      deviceFixture({
        id: "33333333-3333-3333-3333-333333333333",
        device_code: "court-box-2",
        name: "Court 1 and 2 box",
        court_numbers: [1, 2],
        last_seen_at: threeHoursAgo,
      }),
    ]));

    renderPage(<AdminDevicesPage />);

    const notice = await screen.findByText(/The API refuses this box, so it switches nothing on/);
    expect(notice).toHaveTextContent("Nothing in service is reporting on court 2");
    expect(notice).toHaveTextContent("refunded in full with no no-show penalty until one calls in again");
    // The sentence this replaced. It was the one the ledger contradicted.
    expect(notice).not.toHaveTextContent("judged as normal");
    // And not the shut-door sentence either: a box IS in service on court 2, it is just quiet.
    expect(notice).not.toHaveTextContent("nobody can check in there");
  });

  /**
   * The same count, on the branch that reassures rather than warns. One spare still reporting on
   * both of this box's courts is ONE box — the sentence said "Other boxes are still reporting"
   * at every count until round 10, which is the same defect as the quiet clause below, pointing
   * the other way: an admin told several boxes have them covered when one does.
   */
  it("names one covering box as one box, however many of the courts it covers", async () => {
    stubFetch(withDevices([
      deviceFixture({ enabled: false, court_numbers: [1, 2] }),
      deviceFixture({
        id: "33333333-3333-3333-3333-333333333333",
        device_code: "court-box-2",
        name: "Courts 1 and 2 spare",
        court_numbers: [1, 2],
      }),
    ]));

    renderPage(<AdminDevicesPage />);

    const notice = await screen.findByText(/The API refuses this box, so it switches nothing on/);
    expect(notice).toHaveTextContent(
      "Another box is still reporting on courts 1 and 2, so their no-shows are judged as normal.",
    );
    expect(notice).not.toHaveTextContent("Other boxes are");
  });

  /**
   * R9V. The clause that replaced R8V-R3's falsehood carried a new one: it pluralised on the
   * number of COURTS while naming BOXES, so it told an admin the wrong number of boxes to walk
   * to — and it was wrong in both directions, on the screen whose entire job is saying which
   * hardware to go and look at.
   *
   * <p>
   * This is the first direction, read verbatim off the production build in headless Chromium
   * by round 9's verifier: ONE quiet box driving TWO courts said "the other BOXES that drive
   * them HAVE gone quiet". The sentence matrix in `lib/deviceCoverage.test.ts` pins the words;
   * this pins the number the page hands them, which the matrix cannot see.
   * </p>
   */
  it("names one quiet box as one box, however many of the courts it drives", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    stubFetch(withDevices([
      deviceFixture({ enabled: false, court_numbers: [1, 2] }),
      deviceFixture({
        id: "33333333-3333-3333-3333-333333333333",
        device_code: "court-box-2",
        name: "Courts 1 and 2 spare",
        court_numbers: [1, 2],
        last_seen_at: threeHoursAgo,
      }),
    ]));

    renderPage(<AdminDevicesPage />);

    const notice = await screen.findByText(/The API refuses this box, so it switches nothing on/);
    expect(notice).toHaveTextContent(
      "Nothing in service is reporting on courts 1 and 2 — the other box that drives them has gone quiet"
      + " — so bookings on them are refunded in full with no no-show penalty until one calls in again.",
    );
  });

  /**
   * The other direction, and the one an admin pays for: TWO quiet boxes driving ONE court said
   * "the other BOX that drives it HAS gone quiet", so an admin who fixed the one box they were
   * sent to would have left the court dark and still been told the screen was satisfied.
   */
  it("names two quiet boxes on one court as two boxes", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const quiet = (id: string, code: string, name: string) => deviceFixture({
      id, device_code: code, name, court_numbers: [1], last_seen_at: threeHoursAgo,
    });
    stubFetch(withDevices([
      deviceFixture({ enabled: false, court_numbers: [1] }),
      quiet("33333333-3333-3333-3333-333333333333", "court-box-2", "Court 1 spare"),
      quiet("44444444-4444-4444-4444-444444444444", "court-box-3", "Court 1 second spare"),
    ]));

    renderPage(<AdminDevicesPage />);

    const notice = await screen.findByText(/The API refuses this box, so it switches nothing on/);
    expect(notice).toHaveTextContent(
      "Nothing in service is reporting on court 1 — the other boxes that drive it have gone quiet"
      + " — so bookings on it are refunded in full with no no-show penalty until one calls in again.",
    );
  });

  /**
   * One word, read live off the stack by round 8's verifier: the confirm did not pluralise
   * where the row notice did — "Nothing else drives courts 1 and 2 — … and ITS no-shows stop
   * being penalised."
   */
  it("agrees with itself about number when a box strands two courts", async () => {
    stubFetch(withDevices([deviceFixture({ court_numbers: [1, 2] })]));

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Take out of service" }));
    expect(await screen.findByRole("button", {
      // B5 — the armed control is no longer LABELLED by its consequence: the consequence is a
      // block of page text above two side-by-side buttons, and the confirm button shows the
      // words the trigger showed. WCAG 2.5.3 then makes its accessible name open with those
      // words, so the sentence this test is about is a SUFFIX of the name rather than the
      // whole of it. The sentence itself is unchanged and is still what is being held here.
      name: "Take out of service — Out of service? Nothing else drives courts 1 and 2 — the API stops"
        + " taking anything from that box, and from that instant their no-shows stop being penalised.",
    })).toBeInTheDocument();
  });

  /**
   * And the half that was still disagreeing after round 9 fixed the confirm: the row notice and
   * the toast one line below said "bookings on IT" for the same two courts the confirm had just
   * called "their". Round 9's verifier forced `pronoun()` to "it" always and watched vitest stay
   * at 485/485 and Playwright at 230/230, because only the singular arm had ever been asserted.
   */
  it("keeps the toast agreeing with the confirm it follows about number", async () => {
    stubFetch([
      ...withDevices([deviceFixture({ court_numbers: [1, 2] })]),
      { method: "PATCH", path: "/api/v1/admin/devices/11111111-1111-1111-1111-111111111111", body: deviceFixture({ court_numbers: [1, 2], enabled: false }) },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Take out of service" }));
    fireEvent.click(await screen.findByRole("button", { name: /Nothing else drives courts 1 and 2/ }));

    expect(await screen.findByText(
      "Court 1 box is out of service. It switches nothing on, and the club is not alerted about its silence."
      + " No box in service drives courts 1 and 2, so the API turns that hardware away: no scan, walk-up"
      + " or activation from it reaches the club. The courtside PIN, QR and fingerprint terminal is a"
      + " different machine and still checks members in there. Bookings on them nobody checks in on are"
      + " refunded in full with no no-show penalty, from the instant the switch was thrown until a box"
      + " is back in service.",
    )).toBeInTheDocument();
  });

  /**
   * M-F2's poller, gated on the tab being in front. It was a flat 15 s interval that never
   * stopped, so a club that leaves the Devices page open all day made four calls a minute
   * for ever against a screen nobody was looking at.
   *
   * <p>
   * The read on the way back IN is the half that matters, and is why this is not simply a
   * cheaper poller. Pausing alone would leave a returning admin looking at up to fifteen
   * seconds of the state the tab was left in — which is a smaller version of the defect
   * M-F2 was about, on the page an outage email links to.
   * </p>
   */
  it("does not poll a background tab, and re-reads the moment it comes back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const stub = stubFetch(withDevices([deviceFixture()]));
    const setVisibility = (state: string) => {
      Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    };

    try {
      renderPage(<AdminDevicesPage />, { reactStrictMode: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const atLoad = deviceReads(stub);

      setVisibility("hidden");
      for (let i = 0; i < 4; i++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      }
      // A minute in the background costs the API nothing.
      expect(deviceReads(stub)).toBe(atLoad);

      setVisibility("visible");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(deviceReads(stub)).toBe(atLoad + 1);

      // And the interval is live again, rather than having been cleared by the pause.
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(deviceReads(stub)).toBe(atLoad + 2);
    } finally {
      setVisibility("visible");
      vi.useRealTimers();
    }
  });

  // --- the club's walk-up cap, on the screen that sets the buttons (finding M-F1) ----

  /**
   * The button-map editor validated against the 90-minute relay hard cap and nothing else,
   * so a club that lowered its walk-up maximum to 20 left every box still advertising
   * 15/30/45/60 while the API refused three of the four presses with
   * `minutes_out_of_range`. The word "walk-up" did not appear on this page at all, and the
   * member at the box got the blame for the club's own configuration change.
   */
  it("warns which minute buttons the club's own walk-up maximum will refuse", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/settings/"),
      { path: "/api/v1/admin/settings/", body: { ...SETTINGS_FIXTURE, walk_up_max_minutes: 20 } },
    ]);

    renderPage(<AdminDevicesPage />);

    // Buttons 6, 7 and 8 are 30/45/60 in the fixture map; button 5 is 15 and is fine.
    const notice = await screen.findByText(/Buttons 6, 7, 8 grant more than this club's walk-up maximum of 20 minutes/);
    // Both halves of what to do about it, because either one alone is a dead end.
    expect(notice).toHaveTextContent("Walk-up maximum (minutes)");
    expect(notice).toHaveTextContent("or lower the buttons");
  });

  it("says nothing about the walk-up cap when every button is inside it", async () => {
    stubFetch(baseRoutes());

    renderPage(<AdminDevicesPage />);

    await screen.findByLabelText("Button 1 action");
    expect(screen.queryByText(/walk-up maximum/)).not.toBeInTheDocument();
  });

  /**
   * The per-box override is the same rule on a different map — a box given its own map is
   * exactly where a club puts a longer grant, and exactly where nothing warned.
   */
  it("warns on a box's own button map too, and in the singular for one button", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/settings/" && r.path !== "/api/v1/admin/devices/"),
      {
        path: "/api/v1/admin/settings/",
        body: {
          ...SETTINGS_FIXTURE,
          walk_up_max_minutes: 45,
          // The CLUB map is kept inside the cap, so the only notice on the page is the
          // box's own. Otherwise both fire and the query below is ambiguous — which is
          // itself the right behaviour, and not what this test is about.
          button_map: ["court:A", "court:B", "court:C", "court:D", "minutes:15", "minutes:30", "minutes:45", "off"],
        },
      },
      {
        path: "/api/v1/admin/devices/",
        body: [deviceFixture({
          button_map: ["court:A", "none", "none", "none", "minutes:15", "minutes:30", "minutes:45", "minutes:60"],
        })],
      },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Edit buttons/ }));

    // 60 is over; 45 is exactly the cap and is sellable.
    expect(await screen.findByText(/Button 8 grants more than this club's walk-up maximum of 45 minutes/)).toBeInTheDocument();
    expect(screen.getByText(/refuses that press/)).toBeInTheDocument();
  });

  /**
   * R2 I-F6, the second half. With the confirm button no longer forcing 435 px, the widest
   * thing left on the Devices page was a button-map row: a fixed-width label and two
   * intrinsically-sized selects that could neither wrap nor shrink, min-content 362 px, on
   * a page whose content box at 375 px is 343 px. Measured in a headed Chromium: the page
   * went 410 px -> 375 px once the row could wrap, which is the whole of "the admin console
   * fits the phone the admin is holding".
   */
  it("lets a button-map row wrap rather than push the page wider than the phone", async () => {
    stubFetch(baseRoutes());
    renderPage(<AdminDevicesPage />);

    const courtSelect = await screen.findByLabelText("Button 1 court");
    const row = courtSelect.parentElement!;
    expect(row.className).toContain("flex-wrap");
    // A select whose min-width is auto cannot give way inside a flex row, whatever the
    // wrapping does.
    expect(courtSelect.className).toContain("min-w-0");
  });

  /**
   * The empty club, in words that fit whatever it has bought.
   *
   * <p>
   * "No boxes have called in yet" was the only pin on this sentence, and it was in the
   * browser spec alone. A gate registers itself on this list exactly as a court box does, so
   * a club that has installed a door and nothing else read a screen telling it no devices
   * existed in terms of a device it does not own. The heading above the list has said
   * "Connected boards" all along.
   * </p>
   */
  it("says the club has no boards yet, in words that fit a club with only doors", async () => {
    stubFetch(baseRoutes());

    renderPage(<AdminDevicesPage />);

    expect(await screen.findByText(/No boards have called in yet/)).toBeInTheDocument();
    expect(screen.queryByText(/No boxes have called in yet/)).not.toBeInTheDocument();
    // The instruction has to name the key above it: that is the only thing that lets any
    // board register at all, door or box.
    expect(screen.getByText(/Flash one with the key above and power it on/)).toBeInTheDocument();
  });

  // --- door gates -------------------------------------------------------------------

  /**
   * The second kind of board on this list.
   *
   * <p>
   * A gate shares the club key, the heartbeat and the liveness badge with a court box and
   * nothing else: it drives no courts, has no buttons, and its decisions never touch a
   * booking, a check-in, the ledger or the no-show sweep. Every editor and every sentence
   * on this screen was written for a box, so each of these tests holds one of them either
   * ABSENT on a gate row or replaced by something true of a door.
   * </p>
   *
   * <p>
   * The word-by-word matrix of the door's own copy is in `lib/gateCopy.test.ts`, for the
   * same reason the box's is in `lib/deviceCoverage.test.ts`: a page test can only reach
   * the arms a rendered fixture happens to produce, and on the box side that is precisely
   * how three false sentences shipped green. These pin the wiring the matrix cannot see —
   * that the page renders the real generator rather than a hand-built copy of it.
   * </p>
   */
  /**
   * A door, on the Devices page, read-only (A2.5 / D5).
   *
   * <p>
   * <b>Every editing test that used to live here has moved to `AdminDoors.test.tsx`</b>,
   * with the controls: naming a door, clearing its name, the four kind refusals, the length
   * bound, the new-badge clear, shutting, reopening and deleting. None was deleted — each
   * has an equivalent on the surface that now owns it.
   * </p>
   *
   * <p>
   * The reason for the move is the one `lib/gateCopy.ts`'s header records: the out-of-service
   * consequence had three call sites and shipped three rounds running with the three of them
   * disagreeing about what the click had just done. Two screens is two call sites. So this
   * page shows a door and links to it, and Doors owns every control.
   * </p>
   */
  /**
   * <b>A3, on the panel it was not applied to.</b>
   *
   * <p>
   * A reviewer read nine offline rows — some naming a member, some not — with nothing on
   * the page reconciling the two, and concluded the product had lost records. It has not:
   * an offline board decides from the list it last downloaded, so a code ON that list
   * resolves to its holder and a code that is not on it resolves to nobody at all. The
   * doors surface says this once, beside the offline rows; this panel serves the same rows
   * for a court box and said nothing.
   * </p>
   */
  describe("offline rows on a board's own trail", () => {
    it("says once why some of them name a member and others cannot", async () => {
      const server = deviceServer(deviceFixture(), [
        activityFixture({ action: "device.gate_open", reason: null, offline: true }),
        activityFixture({
          action: "device.unknown_scan", reason: null, offline: true, member: null,
          fingerprint: "9ab0cd12",
        }),
      ]);
      stubFetch([...withDevices([]).filter((r) => r.path !== "/api/v1/admin/devices/"), ...server.routes]);

      renderPage(<AdminDevicesPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Box activity" }));

      await screen.findByText(/Unknown code · 9ab0cd12/);
      expect(screen.getByText(/An offline row names somebody when the code was on the door's saved/))
        .toBeInTheDocument();
    });

    /** And it is not printed over a panel with no offline row in it. */
    it("says nothing about offline rows when none of them is offline", async () => {
      const server = deviceServer(deviceFixture(), [activityFixture({ offline: false })]);
      stubFetch([...withDevices([]).filter((r) => r.path !== "/api/v1/admin/devices/"), ...server.routes]);

      renderPage(<AdminDevicesPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Box activity" }));

      await screen.findAllByRole("listitem");
      expect(screen.queryByText(/An offline row names somebody/)).toBeNull();
    });
  });

  describe("a door gate, read-only", () => {
    it("shows a door with its liveness, its door name and a link, under its own heading", async () => {
      stubFetch(withDevices([gateFixture({ gate_key: "front-door", name: "Front door" })]));

      renderPage(<AdminDevicesPage />);

      expect(await screen.findByRole("heading", { name: "Doors" })).toBeInTheDocument();
      expect(screen.getByText("Front door")).toBeInTheDocument();
      expect(screen.getByText(/front-door · gate-0a1b2c/)).toBeInTheDocument();
      // The liveness word is the doors surface's, not the box list's: this product knows the
      // board answered N seconds ago and nothing more.
      expect(screen.getByText("Reporting")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Manage Front door on Doors" }))
        .toHaveAttribute("href", "/admin/monitoring/doors/99999999-9999-9999-9999-999999999999");
    });

    /**
     * <b>A11, and the page it was half-applied on.</b>
     *
     * <p>
     * "Door gate" is the placeholder `DeviceRegistryService` gives every gate that registers
     * itself, and the doors surface stopped presenting it as the club's own word for a board
     * — five boards in that state all read "Door gate" and named none of them. This page
     * went on printing it, so one board was "Unnamed scanner (gate-0a1b2c)" under Doors and
     * "Door gate" here, two clicks apart, on the row that links to the other one.
     * </p>
     */
    it("does not present the registration placeholder as the door's name", async () => {
      stubFetch(withDevices([gateFixture({ gate_key: null, name: "Door gate" })]));

      renderPage(<AdminDevicesPage />);

      await screen.findByRole("heading", { name: "Doors" });
      expect(screen.getByText("Unnamed scanner (gate-0a1b2c)")).toBeInTheDocument();
      expect(screen.queryByText("Door gate")).toBeNull();
      // Including the link's accessible name, which is the one a speech-control user says.
      expect(screen.getByRole("link", { name: /Manage Unnamed scanner \(gate-0a1b2c\) on Doors/ }))
        .toBeInTheDocument();
    });

    it("says a door has no name yet rather than showing a gap", async () => {
      stubFetch(withDevices([gateFixture({ gate_key: null })]));

      renderPage(<AdminDevicesPage />);

      expect(await screen.findByText(/no door name yet · gate-0a1b2c/)).toBeInTheDocument();
    });

    it("goes not-reporting on the club's cadence, exactly as a box does", async () => {
      stubFetch(withDevices([
        gateFixture({ last_seen_at: new Date(Date.now() - 10 * 60_000).toISOString() }),
      ]));

      renderPage(<AdminDevicesPage />);

      // Ten minutes against three beats of the club's 60 s heartbeat. No door-specific
      // arithmetic: one formula, in lib/deviceLiveness, with the 180 s floor.
      expect(await screen.findByText("Not reporting")).toBeInTheDocument();
      expect(screen.getByText("10m ago")).toBeInTheDocument();
    });

    /**
     * <b>The claim this whole describe exists for.</b> Not one control on this page edits,
     * names, shuts, reopens or deletes a door — asserted as an absence, because the failure
     * mode is a control quietly surviving a refactor rather than a control being added back
     * on purpose.
     */
    it("offers no control at all that edits, shuts or deletes a door", async () => {
      stubFetch(withDevices([gateFixture({ gate_key: "front-door" })]));

      renderPage(<AdminDevicesPage />);
      await screen.findByRole("heading", { name: "Doors" });

      for (const name of [
        /Edit name and door/, /Save door/, /^Delete$/, /Take out of service/,
        /Put back in service/, /Shut this door/, /Reopen this door/,
      ]) {
        expect(screen.queryByRole("button", { name })).toBeNull();
      }
      expect(screen.queryByLabelText("Door name")).toBeNull();
      // And it says where those controls went, rather than leaving an admin hunting.
      expect(screen.getByText("Doors are set up and shut under Doors.")).toBeInTheDocument();
    });

    /**
     * The box's own controls are untouched by any of that — the arrangement a club actually
     * has is one page with both kinds on it, and that is the only arrangement that proves
     * the split is per row rather than per page.
     */
    it("keeps a box's editors when a gate is on the same list", async () => {
      stubFetch(withDevices([
        deviceFixture({ court_numbers: [1, 2] }),
        gateFixture({ gate_key: "front-door" }),
      ]));

      renderPage(<AdminDevicesPage />);

      expect(await screen.findByText(/A: court 1, B: court 2/)).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /Edit name and courts/ })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: "Take out of service" })).toHaveLength(1);
    });

    /**
     * And the money half of the same arrangement: a door on a court's wall is not the box
     * that covers that court. Without the kind filter in `deviceCoverage` this confirm would
     * drop to the plain "the box stops switching lights on" — telling an admin that taking
     * the club's only court box out of service strands nothing.
     */
    it("never lets a gate count as cover for a court box", async () => {
      stubFetch(withDevices([
        deviceFixture({ court_numbers: [1] }),
        // A gate carrying a court number, which the API never sends and a hand-edited row
        // could. The filter is on kind, so this changes nothing.
        gateFixture({ court_numbers: [1] }),
      ]));

      renderPage(<AdminDevicesPage />);

      const controls = await screen.findAllByRole("button", { name: "Take out of service" });
      // One control, because only the box has one now.
      expect(controls).toHaveLength(1);
      fireEvent.click(controls[0]);

      expect(await screen.findByRole("button", { name: /Nothing else drives court 1/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /The box stops switching lights on/ })).not.toBeInTheDocument();
    });
  });

  // --- a board's own trail ------------------------------------------------------
  //
  // Round G3, F2. The board has written an audit row for every decision since it shipped
  // and no screen read one.
  //
  // A2.5 moved the DOOR's half of this to /admin/monitoring/doors/:id, where the feed is open on
  // arrival, chip-first, and renders an offline row three distinct ways. What is tested
  // here is the panel this page still has — a court box's — and every claim below is one
  // the panel makes whatever kind of board it is reading.

  describe("a board's activity", () => {
    const activityCalls = (stub: ReturnType<typeof stubFetch>) =>
      stub.calls.filter((c) => c.path.includes("/activity"));

    /**
     * Shut until asked, and read only then. A club with eight boards would otherwise make
     * eight extra calls on every load of a page that already re-reads itself every fifteen
     * seconds, for a panel nobody has opened.
     */
    it("stays shut until an admin asks, and reads the trail only then", async () => {
      const server = deviceServer(deviceFixture(), [activityFixture()]);
      const stub = stubFetch([...withDevices([]).filter((r) => r.path !== "/api/v1/admin/devices/"), ...server.routes]);

      renderPage(<AdminDevicesPage />);

      const toggle = await screen.findByRole("button", { name: "Box activity" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(activityCalls(stub)).toHaveLength(0);
      expect(screen.queryByText("Ada Lovelace")).toBeNull();

      fireEvent.click(toggle);

      await waitFor(() => expect(activityCalls(stub)).toHaveLength(1));
      // The limit the page promises is the limit it asked for, not whatever the server's
      // default happens to become.
      expect(activityCalls(stub)[0].path).toContain("limit=50");
      expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Box activity" })).toHaveAttribute("aria-expanded", "true");
    });

    /**
     * The refusal dictionary, on the screen at last. `too_early` is a token; "Too early for
     * that booking" is the answer to the question the admin was actually asked.
     */
    it("says who was refused and why, in words rather than tokens", async () => {
      const server = deviceServer(deviceFixture(), [
        activityFixture({ action: "gate.denied_too_early", reason: "too_early" }),
      ]);
      const stub = stubFetch([...withDevices([]).filter((r) => r.path !== "/api/v1/admin/devices/"), ...server.routes]);

      renderPage(<AdminDevicesPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Box activity" }));

      expect(await screen.findByText("Refused")).toBeInTheDocument();
      expect(screen.getByText(/Ada Lovelace/)).toBeInTheDocument();
      expect(screen.getByText(/Too early for that booking/)).toBeInTheDocument();
      // Never the raw token on screen. The whole point of the dictionary.
      expect(document.body.textContent).not.toContain("too_early");
      expect(activityCalls(stub)).toHaveLength(1);
    });

    /**
     * An offline refusal names nobody, because the door genuinely cannot: a board deciding
     * from its cached roster has nothing to resolve an unrecognised code against. The
     * fingerprint is the only thing that answers "is the same unknown code being tried over
     * and over at my door", which is the question an admin actually has.
     */
    it("shows an unresolved code as a fingerprint and says the door cannot name anybody", async () => {
      const server = deviceServer(deviceFixture(), [
        activityFixture({ action: "device.unknown_scan", reason: null, offline: true, member: null, fingerprint: "9ab0cd12" }),
      ]);
      stubFetch([...withDevices([]).filter((r) => r.path !== "/api/v1/admin/devices/"), ...server.routes]);

      renderPage(<AdminDevicesPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Box activity" }));

      expect(await screen.findByText(/Unknown code · 9ab0cd12/)).toBeInTheDocument();
      // E-L2 / WIRE-R2 §3: the board looked the code up in the list it last downloaded and
      // did not find it. That IS the reason, and "No reason recorded" read as a gap.
      expect(screen.getByText(/Code not on the door's saved list/)).toBeInTheDocument();
      // And not a member the club failed to identify, which is a different claim.
      expect(document.body.textContent).not.toContain("Unknown member");
    });

    /**
     * An open the BOARD decided while cut off and uploaded afterwards. Without the sentence
     * it reads as an open the API authorised, which is the opposite of what happened and
     * the difference between "the door is behaving" and "the door was on its own".
     */
    it("says an open that happened while the door was offline was the board's own", async () => {
      const server = deviceServer(deviceFixture(), [
        activityFixture({ action: "device.gate_open", reason: null, offline: true }),
      ]);
      stubFetch([...withDevices([]).filter((r) => r.path !== "/api/v1/admin/devices/"), ...server.routes]);

      renderPage(<AdminDevicesPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Box activity" }));

      expect(await screen.findByText(/Lock released while offline/)).toBeInTheDocument();
      expect(screen.getByText("Door opened")).toBeInTheDocument();
    });

    /**
     * An action this screen has no copy for is READ OUT. The set grows from the firmware
     * side, so a panel that showed only what it recognised would be a trail that looks
     * complete while hiding the one new row somebody is looking for.
     */
    it("renders an action nobody wrote copy for rather than dropping the row", async () => {
      const server = deviceServer(deviceFixture(), [
        activityFixture({ action: "device.tamper_detected", reason: null }),
      ]);
      stubFetch([...withDevices([]).filter((r) => r.path !== "/api/v1/admin/devices/"), ...server.routes]);

      renderPage(<AdminDevicesPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Box activity" }));

      expect(await screen.findByText("Tamper detected")).toBeInTheDocument();
      // The raw token stays reachable for whoever has to report it upstream.
      expect(screen.getByText("Tamper detected")).toHaveAttribute("title", "device.tamper_detected");
    });

    /**
     * When, twice: a relative age that answers "is this happening now" at a glance, and the
     * instant behind it for anyone reconciling with a member's account of their evening.
     * The same pair the rest of this page and the ledger already use.
     */
    it("gives each row a relative age and the exact instant behind it", async () => {
      const at = "2026-09-19T18:04:00Z";
      const server = deviceServer(deviceFixture(), [activityFixture({ at })]);
      stubFetch([...withDevices([]).filter((r) => r.path !== "/api/v1/admin/devices/"), ...server.routes]);

      renderPage(<AdminDevicesPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Box activity" }));

      const when = await screen.findByText(/ago$/);
      expect(when).toHaveAttribute("datetime", at);
      // The CLUB's instant, not the reader's. The runner pins TZ to the club's own zone, so
      // this assertion alone cannot tell the two apart — `clubClock.test.ts`'s SURFACES list
      // is what makes the wrong formatter fail, and it names this page from the same commit.
      expect(when.getAttribute("title")).toBe(clubInstant(at));
    });

    it("says nothing is recorded yet rather than showing an empty panel", async () => {
      const server = deviceServer(deviceFixture(), []);
      stubFetch([...withDevices([]).filter((r) => r.path !== "/api/v1/admin/devices/"), ...server.routes]);

      renderPage(<AdminDevicesPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Box activity" }));

      expect(await screen.findByText("Nothing recorded for this box yet.")).toBeInTheDocument();
    });

    /**
     * A failed read says so. Silence would read as an empty trail — which is a claim about
     * the door ("nobody has been through it") rather than about the request.
     */
    it("says so when the trail cannot be read, rather than reading as an empty one", async () => {
      stubFetch([
        ...withDevices([deviceFixture()]),
        { path: "/api/v1/admin/devices/11111111-1111-1111-1111-111111111111/activity", status: 500, body: {} },
      ]);

      renderPage(<AdminDevicesPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Box activity" }));

      expect(await screen.findByText(/Could not read that board's activity/)).toBeInTheDocument();
      // The claim that matters: a failed READ must not render as a claim about the DOOR.
      // "Nothing recorded for this door yet" would tell an admin nobody has been through it.
      expect(screen.queryByText(/Nothing recorded/)).toBeNull();
    });

    /**
     * And where the server does say something, its word wins over the page's fallback —
     * the same rule every other refusal on this screen follows (`describeDeviceError`).
     * Pinned because the fallback above would hide a real server sentence otherwise.
     */
    it("prefers the server's own word for a refused read", async () => {
      stubFetch([
        ...withDevices([deviceFixture()]),
        {
          path: "/api/v1/admin/devices/11111111-1111-1111-1111-111111111111/activity",
          status: 403,
          body: { message: "Your session has expired." },
        },
      ]);

      renderPage(<AdminDevicesPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Box activity" }));

      expect(await screen.findByText("Your session has expired.")).toBeInTheDocument();
      expect(screen.queryByText(/Could not read that board's activity/)).toBeNull();
    });

    /** A box has a trail too, and it is not a door's — the label has to say which. */
    it("calls it box activity on a court box", async () => {
      const server = deviceServer(deviceFixture(), [
        activityFixture({ action: "device.activation", reason: null }),
      ]);
      stubFetch([...withDevices([]).filter((r) => r.path !== "/api/v1/admin/devices/"), ...server.routes]);

      renderPage(<AdminDevicesPage />);
      expect(screen.queryByRole("button", { name: "Box activity" })).toBeNull();
      fireEvent.click(await screen.findByRole("button", { name: "Box activity" }));

      expect(await screen.findByText("Court activated")).toBeInTheDocument();
      // The door's wording nowhere near a box, either on the control or in the panel.
      expect(screen.queryByText(/for this door/)).toBeNull();
    });

    /**
     * A member name is the one arbitrarily wide thing in this panel, and this page has
     * pushed itself wider than a phone on a long name before (R2 I-F6). Fifty rows of it
     * would be fifty chances.
     */
    it("wraps a long member name instead of widening the row", async () => {
      const longName = "Bartholomew Fitzgerald-Montgomery-Wetherby-Ashcombe-Pemberton III";
      const server = deviceServer(deviceFixture(), [
        activityFixture({ member: { id: "44444444-4444-4444-4444-444444444444", name: longName } }),
      ]);
      stubFetch([...withDevices([]).filter((r) => r.path !== "/api/v1/admin/devices/"), ...server.routes]);

      renderPage(<AdminDevicesPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Box activity" }));

      const line = await screen.findByText(new RegExp(longName.slice(0, 20)));
      expect(line.className).toContain("break-words");
      expect(line.className).toContain("min-w-0");
    });

    /** Fifty rows is a screenful, and all fifty are rendered rather than silently cut. */
    it("renders every row the API sent", async () => {
      const rows = Array.from({ length: 50 }, (_, i) => activityFixture({
        action: "gate.denied_no_booking",
        reason: "no_booking",
        at: new Date(Date.now() - i * 60_000).toISOString(),
      }));
      const server = deviceServer(deviceFixture(), rows);
      stubFetch([...withDevices([]).filter((r) => r.path !== "/api/v1/admin/devices/"), ...server.routes]);

      renderPage(<AdminDevicesPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Box activity" }));

      await screen.findAllByText("Refused");
      expect(screen.getAllByText("Refused")).toHaveLength(50);
    });
  });

  // --- boards nobody has acknowledged -------------------------------------------
  //
  // Auto-registration refuses a new MAC once the tenant holds 16 unacknowledged rows, and
  // it refuses the BOARD, with a 409 only firmware ever sees. An admin who flashes a new
  // board and watches it never appear on this list has no error to read anywhere.

  describe("the unacknowledged-board cap", () => {
    const boards = (count: number, auto: number) => Array.from({ length: count }, (_, i) => deviceFixture({
      id: `11111111-1111-1111-1111-${String(i).padStart(12, "0")}`,
      device_code: `box-${i}`,
      name: `box-${i}`,
      auto_registered: i < auto,
    }));

    it("says nothing while the club still has room", async () => {
      stubFetch(withDevices(boards(13, 11)));

      renderPage(<AdminDevicesPage />);

      await screen.findByText("box-0");
      expect(screen.queryByText(/stops registering new boards/)).toBeNull();
    });

    it("warns from twelve unnamed boards, and says what happens at sixteen", async () => {
      stubFetch(withDevices(boards(13, 12)));

      renderPage(<AdminDevicesPage />);

      const notice = await screen.findByText(/stops registering new boards/);
      expect(notice).toHaveTextContent("12 boards have registered themselves");
      expect(notice).toHaveTextContent("At 16");
      expect(notice).toHaveTextContent(/Name the ones you recognise/);
    });

    /**
     * Counted on `auto_registered`, not on the list length. A club with twenty boards an
     * admin has already named is in no danger at all, and warning it would teach the club
     * to ignore the notice that matters.
     */
    it("counts the unnamed boards, not the boards", async () => {
      stubFetch(withDevices(boards(20, 3)));

      renderPage(<AdminDevicesPage />);

      await screen.findByText("box-0");
      expect(screen.queryByText(/stops registering new boards/)).toBeNull();
    });
  });
});
