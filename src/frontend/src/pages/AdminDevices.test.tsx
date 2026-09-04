import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { AdminDevicesPage } from "./AdminDevices";
import {
  COURTS_FIXTURE,
  DISCOVERY_LISTENING,
  SETTINGS_FIXTURE,
  boardFixture,
  deviceFixture,
  renderPage,
  stubFetch,
} from "../test/harness";

/**
 * The Devices screen.
 *
 * <p>
 * Eight device endpoints were live for weeks with zero frontend references — "connecting
 * a board" meant an admin reading an IP off a sticker. These tests are about the things
 * this screen has to get right for somebody standing at a cupboard: does a board that is
 * announcing itself appear, does the claim send what the API actually binds, do the
 * courts go over in relay order, and does saving the button map avoid trampling
 * everything else in the settings document.
 * </p>
 *
 * <p>
 * A court box drives up to four courts, one per relay, so "which court is this box for"
 * is a list, `court_numbers`, indexed A–D. It is snake_case on every request because the
 * API pins that name; the previous claim body sent camelCase fields that bound to nothing.
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
    { path: "/api/v1/admin/devices/discovered", body: [] },
    { path: "/api/v1/admin/devices/discovery-status", body: DISCOVERY_LISTENING },
    { path: "/api/v1/admin/devices/", body: [] },
    { path: "/api/v1/admin/settings/", body: SETTINGS_FIXTURE },
    { path: "/api/v1/admin/courts/", body: COURTS_FIXTURE },
  ];

  it("lists a connected board with its firmware and courts, relay by relay", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      { path: "/api/v1/admin/devices/", body: [deviceFixture({ court_numbers: [1, 3] })] },
    ]);

    renderPage(<AdminDevicesPage />);

    expect(await screen.findByText("Court 1 box")).toBeInTheDocument();
    // Relay order is the meaning: relay A drives court 1, relay B drives court 3.
    expect(screen.getByText(/A: court 1, B: court 3/)).toBeInTheDocument();
    expect(screen.getByText(/firmware 1\.0\.0/)).toBeInTheDocument();
  });

  it("shows a board that has not called in as offline", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      {
        path: "/api/v1/admin/devices/",
        body: [deviceFixture({ last_seen_at: new Date(Date.now() - 10 * 60_000).toISOString() })],
      },
    ]);

    renderPage(<AdminDevicesPage />);

    // A box in a cupboard that stopped talking is the thing an admin most needs to
    // see, and "last seen 10m ago" says it better than a red dot.
    expect(await screen.findByText(/last seen 10m ago/)).toBeInTheDocument();
  });

  it("says loudly when a board could not start its firmware", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      { path: "/api/v1/admin/devices/", body: [deviceFixture({ failed_version: "1.1.0" })] },
    ]);

    renderPage(<AdminDevicesPage />);

    // The firmware's own guard already refuses to reinstall it. This is so a person
    // finds out — a fleet quietly declining an update is the silence noticed a week
    // after the release was promoted everywhere.
    expect(await screen.findByText(/firmware 1\.1\.0 failed to start/)).toBeInTheDocument();
  });

  it("warns when nothing is listening for boards", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/discovery-status"),
      {
        path: "/api/v1/admin/devices/discovery-status",
        body: { ...DISCOVERY_LISTENING, listening: false, state: "Disabled", hint: "Discovery is not enabled on this deployment." },
      },
    ]);

    renderPage(<AdminDevicesPage />);

    // The single most likely reason nothing appears, and completely invisible from
    // the cupboard. Without this an admin power-cycles a working board for an hour.
    const warning = await screen.findByText(/Not listening for boards/);
    // The hint from the server is what turns "nothing here" into an action. Asserted
    // on the enclosing block because the two sentences are separate nodes.
    expect(warning.parentElement).toHaveTextContent(/not enabled on this deployment/);
  });

  it("sends the claim in the shape the API binds: snake_case, courts as a list", async () => {
    const stub = stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/discovered"),
      { path: "/api/v1/admin/devices/discovered", body: [boardFixture()] },
      {
        method: "POST",
        path: "/api/v1/admin/devices/claim",
        body: { device: deviceFixture(), device_key: "abc", key_version: 1, board: boardFixture(), note: "" },
      },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByLabelText("Board 5ccf7f1a2b3c"));
    fireEvent.change(await screen.findByLabelText(/Code on the box/), { target: { value: "k7rm4xpt" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Court 2 box" } });
    fireEvent.change(screen.getByLabelText("Relay A court"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /Connect this board/ }));

    await waitFor(() => {
      const claim = stub.calls.find((c) => c.path.includes("/claim"));
      expect(claim).toBeTruthy();
      // Upper-cased, because the code on the LCD is upper-case and nobody types it
      // that way on a phone. Getting this wrong is a claim that fails for no visible
      // reason while the admin is looking at a code that matches.
      //
      // Every property pinned snake_case, as ClaimBoardRequest declares them. The
      // device code is derived from the courts when the admin leaves it blank.
      expect(claim!.body).toEqual({ claim_code: "K7RM4XPT", device_code: "court-box-2", name: "Court 2 box", court_numbers: [2] });
      // The MAC is how the admin picks a board to read the LCD of; the server matches
      // on the code's commitment, and a stray property would only suggest otherwise.
      expect(claim!.body).not.toHaveProperty("mac");
      expect(claim!.body).not.toHaveProperty("courtNumber");
    });
  });

  it("sends courts in relay order, A first, and keeps the list contiguous", async () => {
    const stub = stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/discovered"),
      { path: "/api/v1/admin/devices/discovered", body: [boardFixture()] },
      {
        method: "POST",
        path: "/api/v1/admin/devices/claim",
        body: { device: deviceFixture(), device_key: "abc", key_version: 1, board: boardFixture(), note: "" },
      },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByLabelText("Board 5ccf7f1a2b3c"));
    fireEvent.change(await screen.findByLabelText(/Code on the box/), { target: { value: "K7RM4XPT" } });

    // B is not reachable until A is set: the list is positional and a gap is not a
    // thing the API can store.
    expect(screen.getByLabelText("Relay B court")).toBeDisabled();

    // Court 3 on relay A, court 1 on relay B — the ORDER is the assignment, so a
    // sorted list would be a wiring change.
    fireEvent.change(screen.getByLabelText("Relay A court"), { target: { value: "3" } });
    expect(screen.getByLabelText("Relay B court")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Relay B court"), { target: { value: "1" } });
    expect(screen.getByLabelText("Relay C court")).toBeEnabled();
    expect(screen.getByLabelText("Relay D court")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Connect this board/ }));

    await waitFor(() => {
      const claim = stub.calls.find((c) => c.path.includes("/claim"));
      expect(claim?.body).toMatchObject({ court_numbers: [3, 1] });
    });
  });

  it("clearing relay A clears the relays after it", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/discovered"),
      { path: "/api/v1/admin/devices/discovered", body: [boardFixture()] },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByLabelText("Board 5ccf7f1a2b3c"));
    fireEvent.change(await screen.findByLabelText("Relay A court"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Relay B court"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Relay A court"), { target: { value: "" } });

    expect(screen.getByLabelText("Relay A court")).toHaveValue("");
    expect(screen.getByLabelText("Relay B court")).toHaveValue("");
    expect(screen.getByLabelText("Relay B court")).toBeDisabled();
  });

  it("will not send a claim without a code, or without a court", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/discovered"),
      { path: "/api/v1/admin/devices/discovered", body: [boardFixture()] },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByLabelText("Board 5ccf7f1a2b3c"));
    // The code is the whole security of claiming — it proves the admin is standing in
    // front of the box. A claim with an empty one must not even be attempted.
    expect(screen.getByRole("button", { name: /Connect this board/ })).toBeDisabled();

    // And a court box with no courts is refused by the API anyway
    // (court_numbers_required_for_court_box); better not to make the call.
    fireEvent.change(await screen.findByLabelText(/Code on the box/), { target: { value: "K7RM4XPT" } });
    expect(screen.getByRole("button", { name: /Connect this board/ })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Relay A court"), { target: { value: "1" } });
    expect(screen.getByRole("button", { name: /Connect this board/ })).toBeEnabled();
  });

  it("turns a button-map mismatch on claim into a sentence", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/discovered"),
      { path: "/api/v1/admin/devices/discovered", body: [boardFixture()] },
      {
        method: "POST",
        path: "/api/v1/admin/devices/claim",
        status: 400,
        body: {
          error: "button_map_selects_court_beyond_device_courts",
          message: "The club's button map selects a court this board would not drive. Give the board that many courts, or change the button map first.",
        },
      },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByLabelText("Board 5ccf7f1a2b3c"));
    fireEvent.change(await screen.findByLabelText(/Code on the box/), { target: { value: "K7RM4XPT" } });
    fireEvent.change(screen.getByLabelText("Relay A court"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /Connect this board/ }));

    // Not "HTTP 400", and not the raw token. The fixture's map has court buttons A–D;
    // a one-court box cannot honour it, and the admin is told what to change.
    expect(await screen.findByText(/button map selects a court this box does not drive/i)).toBeInTheDocument();
  });

  it("changes a box's courts and sends them in relay order", async () => {
    const stub = stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      { path: "/api/v1/admin/devices/", body: [deviceFixture({ court_numbers: [1] })] },
      { method: "PATCH", path: "/api/v1/admin/devices/", body: deviceFixture({ court_numbers: [1, 2] }) },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Edit courts/ }));
    // The row's editor is labelled by the box, so two editors on one screen cannot be
    // confused for each other.
    expect(screen.getByLabelText("Court 1 box relay A court")).toHaveValue("1");
    fireEvent.change(screen.getByLabelText("Court 1 box relay B court"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /Save courts/ }));

    await waitFor(() => {
      const patch = stub.calls.find((c) => c.method === "PATCH");
      expect(patch?.path).toBe("/api/v1/admin/devices/11111111-1111-1111-1111-111111111111");
      expect(patch?.body).toEqual({ court_numbers: [1, 2] });
    });
    expect(await screen.findByText(/now drives A: court 1, B: court 2/)).toBeInTheDocument();
  });

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

  it("saves a remapped button without touching anything else in the settings", async () => {
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
      // Everything else goes back exactly as it was read. A save that dropped a field
      // would have the API treat it as unchanged — which is fine — but a save that
      // sent a WRONG value would silently reprice every court from the devices page.
      expect(body.sliceMinutes).toBe(15);
      expect(body.slicePriceCredits).toBe(8);
      expect(body.creditsPerZarLeague).toBe(2.4);
      expect(body.peakHours).toBe("16:00-19:00");
    });
  });

  it("changes a box's update channel, as the integer the API binds", async () => {
    const stub = stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      { path: "/api/v1/admin/devices/", body: [deviceFixture()] },
      { method: "PATCH", path: "/api/v1/admin/devices/", body: deviceFixture({ ota_channel: "Canary" }) },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.change(await screen.findByLabelText("Court 1 box update channel"), { target: { value: "Canary" } });

    await waitFor(() => {
      const patch = stub.calls.find((c) => c.method === "PATCH");
      // One box goes first so the rest of the club is not the experiment. The API
      // has no string-enum converter, so Canary goes over as 1 — the name never bound.
      expect(patch?.body).toEqual({ otaChannel: 1 });
    });
  });

  it("shows the claim's one-time key until dismissed, and keeps it out of storage", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/discovered"),
      { path: "/api/v1/admin/devices/discovered", body: [boardFixture()] },
      {
        method: "POST",
        path: "/api/v1/admin/devices/claim",
        body: { device: deviceFixture({ name: "Court 2 box" }), device_key: "c0ffee1234", key_version: 1, board: boardFixture({ claimed: true }), note: "Store this key on the board now." },
      },
    ]);
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByLabelText("Board 5ccf7f1a2b3c"));
    fireEvent.change(await screen.findByLabelText(/Code on the box/), { target: { value: "K7RM4XPT" } });
    fireEvent.change(screen.getByLabelText("Relay A court"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /Connect this board/ }));

    // The claim used to toast and drop the key. A board that misses its single-use
    // ten-minute grant was then stranded with nothing an admin could act on.
    const key = await screen.findByLabelText("Device key");
    expect(key).toHaveTextContent("c0ffee1234");
    expect(key.parentElement?.parentElement).toHaveTextContent(/ten minutes from Connect/);
    expect(key.parentElement?.parentElement).toHaveTextContent(/secrets\.h as DEVICE_KEY/);

    fireEvent.click(screen.getByRole("button", { name: /Copy device key/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("c0ffee1234"));

    // Shown once means shown once: nothing a later visitor to this browser can read back.
    for (let i = 0; i < localStorage.length; i++) {
      expect(localStorage.getItem(localStorage.key(i)!)).not.toContain("c0ffee1234");
    }

    fireEvent.click(screen.getByRole("button", { name: /I've stored it/ }));
    expect(screen.queryByLabelText("Device key")).not.toBeInTheDocument();
  });

  it("says what revoking does, and offers to re-claim a revoked box with its details filled in", async () => {
    const stub = stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      { path: "/api/v1/admin/devices/", body: [deviceFixture({ court_numbers: [1, 2] })], sequence: [
        [deviceFixture({ court_numbers: [1, 2] })],
        [deviceFixture({ court_numbers: [1, 2], revoked_at: new Date().toISOString() })],
      ] },
      { method: "POST", path: "/api/v1/admin/devices/11111111-1111-1111-1111-111111111111/revoke", body: deviceFixture({ revoked_at: new Date().toISOString() }) },
    ]);

    renderPage(<AdminDevicesPage />);

    // "Really revoke?" told nobody what it did. The armed label says: the box is
    // refused until it is re-claimed.
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    fireEvent.click(screen.getByRole("button", { name: "Refuse this box until re-claimed?" }));

    await waitFor(() => expect(stub.calls.some((c) => c.path.endsWith("/revoke"))).toBe(true));
    expect(await screen.findByText(/revoked — refused until re-claimed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();

    // A revoked MAC is claimable again on the API; the row hands the claim form the
    // box's details so the admin only types the code on the LCD. The board is not
    // announcing yet in this fixture, and the form says so rather than failing later.
    fireEvent.click(screen.getByRole("button", { name: /Re-claim/ }));
    expect(screen.getByLabelText("Name")).toHaveValue("Court 1 box");
    expect(screen.getByLabelText("Device code")).toHaveValue("court-box-1");
    expect(screen.getByLabelText("Relay A court")).toHaveValue("1");
    expect(screen.getByLabelText("Relay B court")).toHaveValue("2");
    expect(screen.getByText(/5ccf7f1a2b3c is not announcing a claim code yet/)).toBeInTheDocument();
  });

  it("rotates a box's key and shows the new one once", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      { path: "/api/v1/admin/devices/", body: [deviceFixture()] },
      {
        method: "POST",
        path: "/api/v1/admin/devices/11111111-1111-1111-1111-111111111111/rotate-key",
        body: { device: deviceFixture({ key_version: 2 }), device_key: "feedface", key_version: 2 },
      },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Rotate key" }));
    fireEvent.click(screen.getByRole("button", { name: "Refuse it until it has the new key?" }));

    const key = await screen.findByLabelText("Device key");
    expect(key).toHaveTextContent("feedface");
    expect(key.parentElement?.parentElement).toHaveTextContent(/version 2/);
    expect(key.parentElement?.parentElement).toHaveTextContent(/old key stopped working/);
  });

  it("offers a box its own button map only when the API sends the field", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      { path: "/api/v1/admin/devices/", body: [deviceFixture()] },
    ]);

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

  it("registers a box by hand and shows its key once", async () => {
    const stub = stubFetch([
      ...baseRoutes(),
      {
        method: "POST",
        path: "/api/v1/admin/devices/",
        body: { device: deviceFixture({ name: "Bench box", court_numbers: [2, 3] }), device_key: "deadbeef", key_version: 1, note: "Store this key on the device now." },
      },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Register a box by hand/ }));
    fireEvent.change(screen.getByLabelText("Device code"), { target: { value: "bench-box" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bench box" } });
    fireEvent.change(screen.getByLabelText("New box relay A court"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("New box relay B court"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: /Register box/ }));

    await waitFor(() => {
      const post = stub.calls.find((c) => c.method === "POST" && c.path === "/api/v1/admin/devices/");
      // Enums as integers (CourtBox = 0, Esp8266 = 1); courts snake_case, in relay order.
      expect(post?.body).toEqual({ deviceCode: "bench-box", name: "Bench box", kind: 0, hardware: 1, court_numbers: [2, 3] });
    });
    // The key is derived, not stored: this is the only time it will ever be visible,
    // so it stays on screen until the admin says they have it.
    expect(await screen.findByLabelText("Device key")).toHaveTextContent("deadbeef");
  });

  /** Picks the announcing board, types a code and a court, and presses Connect. */
  async function connectTheBoard() {
    fireEvent.click(await screen.findByLabelText("Board 5ccf7f1a2b3c"));
    fireEvent.change(await screen.findByLabelText(/Code on the box/), { target: { value: "K7RM4XPT" } });
    fireEvent.change(screen.getByLabelText("Relay A court"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /Connect this board/ }));
  }

  it("says when a claim re-keyed a board the club already had, rather than adding it twice", async () => {
    const note = "This board was already registered here; its row has been re-keyed and re-enabled. The board collects the new key on its next announce.";
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/discovered"),
      { path: "/api/v1/admin/devices/discovered", body: [boardFixture()] },
      {
        method: "POST",
        path: "/api/v1/admin/devices/claim",
        // What AdminDeviceDiscoveryEndpoints returns for a MAC with an existing row:
        // the same id, key version bumped, reclaimed true.
        body: { device: deviceFixture({ name: "Court 2 box", key_version: 3 }), device_key: "c0ffee", key_version: 3, board: boardFixture({ claimed: true }), reclaimed: true, note },
      },
    ]);

    renderPage(<AdminDevicesPage />);
    await connectTheBoard();

    // "Connected" on a box the admin revoked last week reads as a duplicate row. The
    // outcome is named: re-keyed, same row, new key version.
    expect(await screen.findByText(/Re-keyed Court 2 box/)).toHaveTextContent(/re-enabled with a new key \(version 3\) rather than added twice/);
    const panel = screen.getByLabelText("Device key").parentElement?.parentElement;
    expect(panel).toHaveTextContent(/version 3 \(re-keyed\)/);
    expect(panel).toHaveTextContent(/already had a row here/);
    // The API's own sentence, verbatim, next to the key it is about.
    expect(screen.getByLabelText("Note from the server")).toHaveTextContent(note);
  });

  it("calls a first claim a first claim", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/discovered"),
      { path: "/api/v1/admin/devices/discovered", body: [boardFixture()] },
      {
        method: "POST",
        path: "/api/v1/admin/devices/claim",
        body: { device: deviceFixture({ name: "Court 2 box" }), device_key: "c0ffee", key_version: 1, board: boardFixture({ claimed: true }), reclaimed: false, note: "" },
      },
    ]);

    renderPage(<AdminDevicesPage />);
    await connectTheBoard();

    expect(await screen.findByText(/Connected Court 2 box/)).toBeInTheDocument();
    const panel = screen.getByLabelText("Device key").parentElement?.parentElement;
    expect(panel).toHaveTextContent(/version 1 \(first claim\)/);
    expect(panel).not.toHaveTextContent(/already had a row here/);
    // An empty note is no note — not an empty paragraph.
    expect(screen.queryByLabelText("Note from the server")).not.toBeInTheDocument();
  });

  it("shows the rotation note from the API next to the new key", async () => {
    const note = "The board's old key stops working now. It will show a new claim code on its LCD; connect it again from the discovered boards list to deliver the new key.";
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      { path: "/api/v1/admin/devices/", body: [deviceFixture()] },
      {
        method: "POST",
        path: "/api/v1/admin/devices/11111111-1111-1111-1111-111111111111/rotate-key",
        body: { device: deviceFixture({ key_version: 2 }), device_key: "feedface", key_version: 2, note },
      },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Rotate key" }));
    fireEvent.click(screen.getByRole("button", { name: "Refuse it until it has the new key?" }));

    // The key cannot be pushed to the board; delivery is by re-claim. The API says so
    // in one sentence and that sentence is shown as sent, not paraphrased into a toast
    // that is gone in four seconds.
    expect(await screen.findByLabelText("Device key")).toHaveTextContent("feedface");
    expect(screen.getByLabelText("Note from the server")).toHaveTextContent(note);
    expect(screen.getByLabelText("Device key").parentElement?.parentElement).toHaveTextContent(/version 2 \(rotated\)/);
  });

  it("turns court_number_not_found into a sentence", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      { path: "/api/v1/admin/devices/", body: [deviceFixture({ court_numbers: [1] })] },
      // The courts table is checked on register, update and claim. The picker only offers
      // real courts, so this is a court deleted while the form was open.
      { method: "PATCH", path: "/api/v1/admin/devices/", status: 400, body: { error: "court_number_not_found" } },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Edit courts/ }));
    fireEvent.change(screen.getByLabelText("Court 1 box relay B court"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: /Save courts/ }));

    // Not "court number not found" with the underscores swapped for spaces.
    expect(await screen.findByText(/not a court at this club/)).toHaveTextContent(/add it under Admin settings/);
    // And the editor stays open, since the save did not go through.
    expect(screen.getByRole("button", { name: /Save courts/ })).toBeInTheDocument();
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

    // A courts change.
    fireEvent.click(await screen.findByRole("button", { name: /Edit courts/ }));
    fireEvent.change(screen.getByLabelText("Court 1 box relay B court"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /Save courts/ }));
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "PATCH")).toHaveLength(1));

    // A channel change.
    fireEvent.change(screen.getByLabelText("Court 1 box update channel"), { target: { value: "Canary" } });
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "PATCH")).toHaveLength(2));

    // The API binds button_map three-valued — absent leaves the override alone, null
    // clears it, a list sets it — so a PATCH about something else must not carry the key
    // at all: not as null (that would clear the box's map), not as its current value
    // (a stale echo racing another admin's edit). Asserted on the wire text, because a
    // parsed object cannot tell "absent" from "present as undefined".
    const patches = stub.calls.filter((c) => c.method === "PATCH");
    expect(Object.keys(patches[0].body as object)).toEqual(["court_numbers"]);
    expect(Object.keys(patches[1].body as object)).toEqual(["otaChannel"]);
    for (const patch of patches) expect(patch.raw).not.toContain("button_map");

    // And "club default" is a PATCH whose body is exactly `{"button_map":null}` — the
    // one value the API reads as "clear the override".
    fireEvent.click(screen.getByRole("button", { name: /Edit buttons/ }));
    fireEvent.click(screen.getByLabelText(/Use the club's button map/));
    fireEvent.click(screen.getByRole("button", { name: /Save buttons/ }));
    await waitFor(() => expect(stub.calls.filter((c) => c.method === "PATCH")).toHaveLength(3));
    expect(stub.calls.filter((c) => c.method === "PATCH")[2].raw).toBe('{"button_map":null}');
  });
});
