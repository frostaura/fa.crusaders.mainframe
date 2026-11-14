import { useCallback, useEffect, useState } from "react";
import { adminEndpoints, type ControlBoardView } from "../../lib/adminApi";
import { endpoints, type AdminDevice, type AdminSettings, type DeviceApiKey } from "../../lib/api";
import type { BoardsContext } from "../../lib/boardScreen";
import { landingCourtsFor } from "../../lib/landingPreview";
import { diagRises, megaDiag, type MegaDiagName } from "../../lib/deviceHealth";

/**
 * What the Boards page reads beside the board list for the v3 lines (device-api §10): the club
 * network's version, the key ids, and the courts' lights for each
 * board's start-screen preview.
 *
 * <p>
 * <b>Each read is its own.</b> A failed or absent one costs only the line it feeds — a board whose
 * network version cannot be compared still shows its own, a page without the control board shows no
 * preview — and none of them can take the board list down with it. An API before v3 answers 404
 * for the new routes, which is the same as "not served" here.
 * </p>
 */
export function useBoardsContext(
  settings: AdminSettings | null, devices: readonly AdminDevice[], now: number,
): BoardsContext & { reload: () => void } {
  const [networkVer, setNetworkVer] = useState<number | null>(null);
  const [key, setKey] = useState<DeviceApiKey | null>(null);
  const [board, setBoard] = useState<ControlBoardView | null>(null);

  const reload = useCallback(() => {
    // Each answer is checked for its shape: a reply that is not what the route serves feeds no line.
    void endpoints.adminDeviceNetwork().then(
      (n) => setNetworkVer(typeof n?.ver === "number" ? n.ver : null), () => setNetworkVer(null));
    void endpoints.adminDeviceApiKey().then((k) => setKey(typeof k === "object" && k !== null ? k : null), () => setKey(null));
    void adminEndpoints.controlBoard().then((b) => setBoard(Array.isArray(b?.courts) ? b : null), () => setBoard(null));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // The Mega's !DIAG counters as first read on this page, per board: a rise is measured from
  // here, so "3 more since you opened this page" is a fact this page saw, not a guess.
  const [baseline, setBaseline] = useState<Record<string, Record<MegaDiagName, number>>>({});
  useEffect(() => {
    const fresh = devices.filter((d) => baseline[d.id] === undefined && megaDiag(d.mega) !== null);
    if (fresh.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a baseline taken once per board as it first appears
    setBaseline((held) => ({ ...held, ...Object.fromEntries(fresh.map((d) => [d.id, megaDiag(d.mega)!])) }));
  }, [devices, baseline]);
  const risesOf = useCallback((device: AdminDevice) => diagRises(baseline[device.id] ?? null, megaDiag(device.mega)), [baseline]);

  const courtsOf = useCallback((device: AdminDevice) => (
    board ? landingCourtsFor(device.court_numbers, board.courts, now) : null
  ), [board, now]);

  return {
    networkVer,
    keyId: key?.key_id ?? null,
    nextKeyId: key?.rotation?.next_id ?? null,
    courtsOf,
    timezone: board?.timezone ?? settings?.timezone,
    club: {
      layout: settings?.lcd_layout,
      marquee: settings?.lcd_marquee_enabled,
      stepMs: settings?.lcd_marquee_step_ms,
      pageSeconds: settings?.lcd_landing_page_seconds,
    },
    now,
    settings,
    risesOf,
    reload,
  };
}
