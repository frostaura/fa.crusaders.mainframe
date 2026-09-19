import { Link } from "react-router-dom";
import { Card } from "../Card";
import { DoorAge } from "./DoorAge";
import { DoorChips } from "./DoorChips";
import { isOnline, offlineAfterSecondsFor } from "../../lib/deviceLiveness";
import { doorScanCountHeading, doorScanCountLine, doorStateNotice } from "../../lib/doorsCopy";
import { UNNAMED_GATE } from "../../lib/gateCopy";
import { type DoorRow } from "../../lib/api";

/**
 * One door, answering "is the front door working?" in a glance, on a phone, on bad WiFi.
 *
 * <p>
 * Nothing here is behind a disclosure and nothing here writes. The name IS the link — one
 * tab stop per door rather than two, and a separate "open this door's page" button is
 * deliberately absent.
 * </p>
 *
 * <p>
 * `min-w-0 break-words` on the name and the identity line because a `gate_key` may be 64
 * characters of somebody's own naming scheme with no space in it, and an unbreakable token
 * pushes the whole page wider than the phone — the Devices page's finding I-F6 with a larger
 * token.
 * </p>
 */
export function DoorTile({ row, now, tenantHeartbeat, timezone, dayStartedAt }: {
  row: DoorRow;
  now: number;
  tenantHeartbeat: number | null;
  timezone: string;
  dayStartedAt: string;
}) {
  const device = row.device;
  const online = isOnline(device, offlineAfterSecondsFor(device, tenantHeartbeat), now);
  const nameId = `door-${device.id}-name`;
  return (
    <Card>
      <article aria-labelledby={nameId} className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 id={nameId} className="min-w-0 break-words text-base font-semibold">
            <Link to={`/admin/doors/${device.id}`} className="inline-flex min-h-11 items-center text-accent-strong">
              {device.name}
            </Link>
          </h3>
          <DoorChips device={device} online={online} signals={row.signals} />
        </div>

        <p className="min-w-0 break-words text-xs text-text-muted">
          {`${device.gate_key ?? UNNAMED_GATE} · ${device.device_code}`}
        </p>

        <DoorAge at={device.last_seen_at} now={now} prefix={online ? "Heard from" : "Last heard from"} />

        <p className="border-t border-border pt-3 text-sm text-text-secondary">
          {doorStateNotice(device, online, timezone)}
        </p>

        <div className="border-t border-border pt-3">
          <p className="text-xs text-text-muted">{doorScanCountHeading(dayStartedAt, timezone)}</p>
          <p className="text-sm text-text-secondary">{doorScanCountLine(row.today)}</p>
          {device.running_version && (
            <p className="mt-1 text-xs text-text-muted">{`firmware ${device.running_version}`}</p>
          )}
        </div>
      </article>
    </Card>
  );
}
