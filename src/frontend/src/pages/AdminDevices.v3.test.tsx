import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { AdminDevicesPage } from "./AdminDevices";
import {
  COURTS_FIXTURE, DEVICE_API_KEY_FIXTURE, SETTINGS_FIXTURE, deviceFixture, deviceServer, refuse, renderPage, stubFetch,
  type StubRoute,
} from "../test/harness";
import { RELAY_LEVEL_CONFIRM } from "../lib/deviceHardware";

/**
 * Boards, device contract v3 (device-api §6–§8, §10, §12, §13; member-code §8). The panels that
 * replace a cable: the club network, signed firmware, the member-code rollout, and per board its
 * hardware facts and health. Each panel is tested in its three states — still reading, a failed
 * read, the answer — and every consequential write behind its confirm, with what went over the wire.
 */

const BOX_ID = "11111111-1111-1111-1111-111111111111";

const v3Box = (extra: Record<string, unknown> = {}) => deviceFixture({
  court_numbers: [1, 2], capabilities: "codes:m1 hb:3 lcd:2 ota:1 key:1 net:1",
  lcd_layout: null, lcd_marquee_enabled: null, lcd_layout_acknowledged: "compact", lcd_layout_acknowledged_at: "2026-11-13T18:05:00Z",
  fw_state: "committed", running_version: "3.0.0", mega_version: "3.0.0", net_ver: 2, net_src: "server", key_id: "k1",
  hw_relay_active_level: null, hw_lcd_i2c_address: null, hw_scanner_baud: null, hw_scanner_line_end: null, hw_scanner_gap_ms: null,
  mega: { reset: "01", lcd: "27", relay: "high", scan_baud: 9600, scan_end: "auto", keys: "0F", diag: [0, 3, 0, 0, 0] },
  diag: { reset: "power_on", heap: 21000, heap_min: 18000, block: 9000, stack_min: 900, sketch_free: 1_000_000, flash_mb: 4 },
  drift: null,
  ...extra,
});

const SETTINGS = {
  ...SETTINGS_FIXTURE,
  version: "v-1",
  lcd_layout: "compact", lcd_marquee_enabled: true,
  hw_relay_active_level: "high", hw_lcd_i2c_address: 0, hw_scanner_baud: 0, hw_scanner_line_end: "auto", hw_scanner_gap_ms: 150,
  device_net_fallback_minutes: 10,
  bounds: {
    hw_relay_active_level: { values: ["high", "low"] },
    hw_lcd_i2c_address: { values: [0, 32, 39, 56, 63] },
    hw_scanner_baud: { values: [0, 9600, 115200] },
    hw_scanner_line_end: { values: ["auto", "crlf"] },
    hw_scanner_gap_ms: { min: 50, max: 500 },
  },
};

const NETWORK = {
  ver: 2, base: "http://192.168.1.20:8088", wifi: [{ ssid: "CRUSADERS", psk_set: true }],
  updated_at: "2026-11-13T16:00:00Z", updated_by: "Dean",
};

const RELEASE = {
  id: "rel-1", target: "court_bridge", version: "3.0.1", size: 372144, sha256: "a".repeat(64),
  uploaded_at: "2026-11-13T17:00:00Z", rollout: "off", rollout_device_id: null, paused: false, boards: {},
};

const ROLLOUT = {
  phase: "legacy", cutover_at: null, cutoff_at: null, cutoff_days: 14, cutoff_due_at: null,
  enabled_boards: 1, ready_boards: 0,
  blocking: [{ id: BOX_ID, device_code: "court-box-1", name: "Court 1 box", kind: "CourtBox", running_version: "3.0.0", capabilities: null, last_seen_at: "2026-11-13T18:00:00Z" }],
  unacknowledged: [{ id: BOX_ID, device_code: "court-box-1", name: "Court 1 box", kind: "CourtBox", running_version: "3.0.0", capabilities: null, last_seen_at: "2026-11-13T18:00:00Z" }],
  manual_hold: false, manual_hold_by: null, manual_hold_at: null,
  keys: [{ id: BOX_ID, name: "Court 1 box", keys_sent: 64, keys_trimmed: 5, keys_sent_at: null }],
};

function routes(over: { device?: Record<string, unknown>; network?: Partial<StubRoute>; firmware?: Partial<StubRoute>; rollout?: Partial<StubRoute> } = {}) {
  const server = deviceServer(over.device ?? v3Box({ auto_registered: true }));
  const list: StubRoute[] = [
    { path: "/api/v1/admin/devices/api-key", body: { ...DEVICE_API_KEY_FIXTURE, key_id: "k1", rotation: null } },
    ...server.routes,
    { path: "/api/v1/admin/devices/network", body: NETWORK, ...over.network },
    { path: "/api/v1/admin/devices/firmware", body: [RELEASE], ...over.firmware },
    { path: "/api/v1/admin/devices/member-codes", body: ROLLOUT, ...over.rollout },
    { path: "/api/v1/admin/settings/", body: SETTINGS },
    { path: "/api/v1/admin/courts/", body: COURTS_FIXTURE },
    { path: "/api/v1/admin/control-board", status: 404, body: { error: "not_found" } },
  ];
  return { server, list };
}

const panel = (name: string) => document.querySelector<HTMLElement>(`[data-panel="${name}"]`);

async function confirmIn(trigger: string | RegExp, confirm: string | RegExp, scope?: HTMLElement) {
  fireEvent.click(await (scope ? within(scope).findByRole("button", { name: trigger }) : screen.findByRole("button", { name: trigger })));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: confirm }));
  return dialog;
}

describe("Boards › Club network (device-api §8)", () => {
  it("reads first, then says what the boards call and which board keeps its own", async () => {
    const { list } = routes({ device: v3Box({ net_src: "local" }) });
    stubFetch(list);
    renderPage(<AdminDevicesPage />);
    expect(await screen.findByText("The boards call http://192.168.1.20:8088.")).toBeInTheDocument();
    expect(screen.getByText(/First WiFi: CRUSADERS \(password saved\)/)).toBeInTheDocument();
    expect(panel("club-network")).toHaveTextContent(/Set up at the box itself.+Court 1 box/);
  });

  it("says a failed read is a failure, never an empty network", async () => {
    stubFetch(routes({ network: { status: 500, body: { error: "boom" } } }).list);
    renderPage(<AdminDevicesPage />);
    await waitFor(() => expect(panel("club-network")).toHaveTextContent(/Couldn.t read the club network/));
    expect(panel("club-network")).not.toHaveTextContent(/The boards call/);
  });

  it("is absent against an API without it", async () => {
    stubFetch(routes({ network: { status: 404, body: { error: "not_found" } } }).list);
    renderPage(<AdminDevicesPage />);
    await screen.findByText("Court 1 box");
    await waitFor(() => expect(panel("firmware")).not.toBeNull());
    expect(panel("club-network")).toBeNull();
  });

  it("keeps a stored password unless one is typed, and sends the version it read", async () => {
    const { list } = routes();
    const stub = stubFetch([...list, { method: "PUT", path: "/api/v1/admin/devices/network", body: { ...NETWORK, ver: 3, base: "http://10.0.0.5:8088" } }]);
    renderPage(<AdminDevicesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Change the network" }));
    fireEvent.change(screen.getByLabelText(/Server address the boards call/), { target: { value: "http://10.0.0.5:8088" } });
    await confirmIn("Save the network", "Send it to the boards");
    await waitFor(() => expect(stub.calls.some((c) => c.method === "PUT")).toBe(true));
    expect(stub.calls.find((c) => c.method === "PUT")!.body).toEqual({
      ver: 2, base: "http://10.0.0.5:8088", wifi: [{ ssid: "CRUSADERS", psk: null }],
    });
  });

  it("refuses an https address before it is sent, in words", async () => {
    const stub = stubFetch(routes().list);
    renderPage(<AdminDevicesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Change the network" }));
    fireEvent.change(screen.getByLabelText(/Server address the boards call/), { target: { value: "https://club.example" } });
    expect(screen.getAllByText(/Boards can only call plain http:\/\//).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Save the network" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Send it to the boards" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(stub.calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

describe("Boards › Firmware (device-api §7)", () => {
  it("shows the release and offers it to every board behind a confirm", async () => {
    const { list } = routes();
    const stub = stubFetch([...list, { method: "PATCH", path: "/api/v1/admin/devices/firmware/rel-1", body: { ...RELEASE, rollout: "all" } }]);
    renderPage(<AdminDevicesPage />);
    expect(await screen.findByText(/^3\.0\.1, uploaded .+ — offered to nobody\.$/)).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Offer it to" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: "Every board of this kind" }));
    await confirmIn("Apply", "Offer the update");
    await waitFor(() => expect(stub.calls.find((c) => c.method === "PATCH" && c.path.includes("firmware"))?.body)
      .toEqual({ rollout: "all", device_id: null }));
  });

  it("says a failed read is a failure", async () => {
    stubFetch(routes({ firmware: { status: 503, body: { error: "down" } } }).list);
    renderPage(<AdminDevicesPage />);
    await waitFor(() => expect(panel("firmware")).toHaveTextContent(/Couldn.t read the firmware releases/));
  });

  it("names the board's progress against the latest release", async () => {
    stubFetch(routes().list);
    renderPage(<AdminDevicesPage />);
    await waitFor(() => expect(panel("firmware")).toHaveTextContent(/Court 1 box: Firmware 3\.0\.0 · 3\.0\.1 is available/));
  });
});

describe("Member codes › Rollout (member-code §8)", () => {
  it("is blocked by an unacknowledged court box, which can be acknowledged with its courts as they are", async () => {
    const { list } = routes();
    const stub = stubFetch(list);
    renderPage(<AdminDevicesPage />);
    await waitFor(() => expect(document.querySelector("[data-rollout-state]")?.getAttribute("data-rollout-state")).toBe("blocked"));
    expect(panel("member-codes")).toHaveTextContent(/Court 1 box has not been checked by an admin/);
    expect(panel("member-codes")).toHaveTextContent(/64 keys last sent — 5 did not fit/);
    const dialog = await confirmIn("Acknowledge", "Acknowledge it", panel("member-codes")!);
    expect(dialog).toHaveTextContent(/A: court 1, B: court 2/);
    await waitFor(() => expect(stub.calls.find((c) => c.method === "PATCH")?.body).toEqual({ court_numbers: [1, 2] }));
  });

  it("holds the rollout with only the hold and the version it read", async () => {
    const { list } = routes();
    const stub = stubFetch([...list, { method: "PUT", path: "/api/v1/admin/settings/", body: { saved: true, version: "v-2" } }]);
    renderPage(<AdminDevicesPage />);
    await confirmIn("Hold the rollout", "Hold it", await waitFor(() => { expect(panel("member-codes")).not.toBeNull(); return panel("member-codes")!; }));
    await waitFor(() => expect(stub.calls.find((c) => c.method === "PUT")?.body).toEqual({ version: "v-1", member_code_manual_hold: true }));
  });

  it("shows who held it, and offers to lift the hold", async () => {
    stubFetch(routes({ rollout: { body: { ...ROLLOUT, blocking: [], unacknowledged: [], manual_hold: true, manual_hold_by: "Dean", manual_hold_at: "2026-11-13T16:00:00Z" } } }).list);
    renderPage(<AdminDevicesPage />);
    await waitFor(() => expect(panel("member-codes")).toHaveTextContent(/Held by Dean since/));
    expect(within(panel("member-codes")!).getByRole("button", { name: "Lift the hold" })).toBeInTheDocument();
  });

  it("is clear when nothing is in the way", async () => {
    stubFetch(routes({ rollout: { body: { ...ROLLOUT, blocking: [], unacknowledged: [], ready_boards: 1 } } }).list);
    renderPage(<AdminDevicesPage />);
    await waitFor(() => expect(document.querySelector("[data-rollout-state]")?.getAttribute("data-rollout-state")).toBe("clear"));
  });

  it("says a failed read does not mean nothing is blocking", async () => {
    stubFetch(routes({ rollout: { status: 500, body: { error: "boom" } } }).list);
    renderPage(<AdminDevicesPage />);
    await waitFor(() => expect(panel("member-codes")).toHaveTextContent(/That does not mean nothing is blocking it/));
  });
});

describe("one board's hardware and health (device-api §12, §13)", () => {
  it("shows what the box runs with beside what it is set to", async () => {
    stubFetch(routes({ device: v3Box() }).list);
    renderPage(<AdminDevicesPage />);
    const hw = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-board-hardware]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(hw).toHaveTextContent(/Screen \(LCD\) addressset to search for it \(the club's\) · the box says 0x27/);
    expect(hw).toHaveTextContent(/Scanner speedset to auto-detect \(the club's\) · the box says 9600 baud/);
  });

  it("makes no screen answered an attention state", async () => {
    stubFetch(routes({ device: v3Box({ mega: { reset: "01", lcd: "00", relay: "high" } }) }).list);
    renderPage(<AdminDevicesPage />);
    expect(await screen.findByText(/No screen answered this box/)).toBeInTheDocument();
    expect(document.querySelector("[data-board-health]")?.getAttribute("data-board-health")).toBe("attention");
  });

  it("names the keys a board could not read", async () => {
    stubFetch(routes({ device: v3Box({ drift: ["roster"] }) }).list);
    renderPage(<AdminDevicesPage />);
    expect(await screen.findByText(/could not read part of the club's last answer: roster/)).toBeInTheDocument();
  });

  it("changes the relay drive level only behind a confirm that says what a lit court does", async () => {
    const { list, server } = routes({ device: v3Box() });
    const stub = stubFetch(list);
    renderPage(<AdminDevicesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit hardware" }));
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Relay drive level" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: "low (active-low module)" }));
    fireEvent.click(screen.getByRole("button", { name: "Save hardware" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(RELAY_LEVEL_CONFIRM);
    expect(stub.calls.some((c) => c.method === "PATCH")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Change the drive level" }));
    await waitFor(() => expect(stub.calls.find((c) => c.method === "PATCH")?.body).toEqual({ hw_relay_active_level: "low" }));
    expect(server.current().hw_relay_active_level).toBe("low");
  });

  it("sends a numeric hardware choice as a number, and the club's as null", async () => {
    const { list } = routes({ device: v3Box({ hw_scanner_baud: 9600 }) });
    const stub = stubFetch(list);
    renderPage(<AdminDevicesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit hardware" }));
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Screen (LCD) address" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: "0x27" }));
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Scanner speed" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: /^The club's/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save hardware" }));
    await waitFor(() => expect(stub.calls.find((c) => c.method === "PATCH")?.body).toEqual({ hw_lcd_i2c_address: 39, hw_scanner_baud: null }));
  });

  it("has nothing to save until a value changes", async () => {
    const { list } = routes({ device: v3Box() });
    stubFetch([...list, { method: "PATCH", path: "/api/v1/admin/devices/", body: refuse(400, { error: "hw_scanner_gap_ms_out_of_range", min: 50, max: 500 }) }]);
    renderPage(<AdminDevicesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit hardware" }));
    expect(screen.getByRole("button", { name: "Save hardware" })).toBeDisabled();
  });
});
