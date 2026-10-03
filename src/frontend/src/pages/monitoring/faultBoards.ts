import type { DeviceErrorRow } from "../../lib/adminApi";
import { boardLabel } from "../../lib/deviceFaultCopy";

/** One board's worth of faults, which is the unit an admin acts on. */
export type Board = { key: string; name: string; rows: DeviceErrorRow[] };

/**
 * Group by board, newest-seen board first.
 *
 * <p>
 * A row with no `device_id` is real and must not be dropped: an authentication failure has no
 * device row by definition, and it is exactly the fault an admin most needs to see. It gets
 * its own group named for what it is rather than being hidden under a board that did not
 * report it.
 * </p>
 */
export function groupByBoard(rows: DeviceErrorRow[]): Board[] {
  const byKey = new Map<string, Board>();
  for (const row of rows) {
    const key = row.device_id ?? "__no_board__";
    /*
      A row with no `device_id` is NOT named after the code the caller claimed. An
      authentication failure carries `claimed_device_code`, which is a string an
      unauthenticated caller chose — filing it under "CB-01" would put an intruder's rows
      inside the club's own board, which is the one place an admin would never look for them.
    */
    const name = row.device_id
      ? boardLabel(row)
      : "Not from a board the club knows";
    const board = byKey.get(key) ?? { key, name, rows: [] };
    board.rows.push(row);
    byKey.set(key, board);
  }
  return [...byKey.values()].sort((a, b) => {
    const latest = (board: Board) => Math.max(...board.rows.map((r) => Date.parse(r.last_seen_at) || 0));
    return latest(b) - latest(a);
  });
}
