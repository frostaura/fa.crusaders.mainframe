import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { KEY_COPY, releaseLine } from "./deviceV3Copy";
import { blockingWhy, isUnacknowledged } from "./memberCodeRollout";
import type { FirmwareRelease, MemberCodeRollout, MemberCodeRolloutBoard } from "./api";

/**
 * The console's v3 device surfaces were built before the API that serves them (both lanes worked
 * from device-api.md at once), and the integration found five places where the two had read the
 * spec differently: the board's restore report, a release's one board, a release's board counts,
 * the rollout's per-board keys and blocking reason, and the phrases the key retire / restore
 * dialogs send. Each would have rendered nothing, or sent a body the API refuses, with every
 * stubbed test green. This file pins the console's reading against the server's own source, so a
 * rename on either side goes red here rather than on the club's Boards page.
 */
const api = resolve(__dirname, "../../../backend/Crusaders.Mainframe.Api");
const read = (rel: string) => readFileSync(resolve(api, rel), "utf8");

describe("the v3 device wire, as the API serialises it", () => {
  it("retires and restores with the API's own confirmation phrases", () => {
    const ring = read("Services/DeviceKeyRing.cs");
    expect(ring).toContain(`RetirePhrase = "${KEY_COPY.retirePhrase}"`);
    expect(ring).toContain(`RestorePhrase = "${KEY_COPY.restoreWord}"`);
  });

  it("reads the board fields the device view actually carries", () => {
    const view = read("Endpoints/DeviceView.cs");
    for (const key of ["restore_report", "restore_reported_at", "code_keys_sent", "code_keys_trimmed", "code_keys_at",
      "fw_state", "net_ver", "net_src", "key_id", "lcd_layout_acknowledged", "mega", "diag", "drift", "telemetry_at"]) {
      expect(view, key).toMatch(new RegExp(`\\b${key} = `));
    }
    expect(view).not.toMatch(/\brestore = /);
  });

  it("reads a release's one board and its board counts by the names the list serves", () => {
    const firmware = read("Services/FirmwareService.cs");
    expect(firmware).toContain("rollout_device_id = r.RolloutDeviceId");
    for (const key of ["of_target", "included", "running", "downloading", "probation", "failed", "cannot_update"]) {
      expect(firmware, key).toMatch(new RegExp(`\\b${key} = `));
    }
    const release: FirmwareRelease = {
      id: "r1", target: "court_bridge", version: "3.0.1", size: 1, sha256: "x", uploaded_at: "2026-11-13T17:00:00Z",
      rollout: "all", rollout_device_id: null, paused: false,
      boards: { of_target: 4, included: 4, running: 2, downloading: 1, probation: 0, failed: 1, cannot_update: 0 },
    };
    expect(releaseLine(release)).toMatch(/\(2 running it, 1 downloading, 1 refused it\)\.$/);
  });

  it("reads the rollout's per-board keys and each blocker's reason", () => {
    const devices = read("Endpoints/AdminDeviceEndpoints.cs");
    expect(devices).toContain("keys = boards.Select(Row).ToList()");
    expect(devices).toContain('[JsonPropertyName("blocks")]');
    for (const reason of ["no_member_codes", "no_keyed_heartbeat", "unacknowledged"]) expect(devices).toContain(`"${reason}"`);

    const board: MemberCodeRolloutBoard = {
      id: "b1", device_code: "box-01", name: "Court 1 box", kind: "CourtBox", running_version: "3.0.0",
      capabilities: ["codes:m1", "hb:3"], last_seen_at: null, blocks: "no_keyed_heartbeat",
    };
    const rollout = { unacknowledged: [], blocking: [board] } as unknown as MemberCodeRollout;
    expect(blockingWhy(board, isUnacknowledged(board, rollout, []))).toMatch(/has not been sent its member-code keys/);
    const spare = { ...board, blocks: "unacknowledged" as const };
    expect(isUnacknowledged(spare, rollout, [])).toBe(true);
  });
});
