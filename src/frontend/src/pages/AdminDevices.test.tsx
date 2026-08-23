import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { AdminDevicesPage } from "./AdminDevices";
import {
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
 * a board" meant an admin reading an IP off a sticker. These tests are about the three
 * things this screen has to get right for somebody standing at a cupboard: does a board
 * that is announcing itself appear, does the claim send the code they typed, and does
 * saving the button map avoid trampling everything else in the settings document.
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
  ];

  it("lists a connected board with its firmware and court", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      { path: "/api/v1/admin/devices/", body: [deviceFixture()] },
    ]);

    renderPage(<AdminDevicesPage />);

    expect(await screen.findByText("Court 1 box")).toBeInTheDocument();
    expect(screen.getByText(/court 1/)).toBeInTheDocument();
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

  it("sends the code the admin typed, and the board they picked", async () => {
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
    fireEvent.change(screen.getByLabelText("Court number"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /Connect this board/ }));

    await waitFor(() => {
      const claim = stub.calls.find((c) => c.path.includes("/claim"));
      expect(claim).toBeTruthy();
      // Upper-cased, because the code on the LCD is upper-case and nobody types it
      // that way on a phone. Getting this wrong is a claim that fails for no visible
      // reason while the admin is looking at a code that matches.
      expect(claim!.body).toMatchObject({ mac: "5ccf7f1a2b3c", claimCode: "K7RM4XPT", name: "Court 2 box", courtNumber: 2 });
    });
  });

  it("will not send a claim without a code", async () => {
    stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/discovered"),
      { path: "/api/v1/admin/devices/discovered", body: [boardFixture()] },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.click(await screen.findByLabelText("Board 5ccf7f1a2b3c"));
    // The code is the whole security of claiming — it proves the admin is standing in
    // front of the box. A claim with an empty one must not even be attempted.
    expect(screen.getByRole("button", { name: /Connect this board/ })).toBeDisabled();
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

  it("changes a box's update channel", async () => {
    const stub = stubFetch([
      ...baseRoutes().filter((r) => r.path !== "/api/v1/admin/devices/"),
      { path: "/api/v1/admin/devices/", body: [deviceFixture()] },
      { method: "PATCH", path: "/api/v1/admin/devices/", body: { saved: true } },
    ]);

    renderPage(<AdminDevicesPage />);

    fireEvent.change(await screen.findByLabelText("Court 1 box update channel"), { target: { value: "Canary" } });

    await waitFor(() => {
      const patch = stub.calls.find((c) => c.method === "PATCH");
      // One box goes first so the rest of the club is not the experiment.
      expect(patch?.body).toMatchObject({ otaChannel: "Canary" });
    });
  });
});
