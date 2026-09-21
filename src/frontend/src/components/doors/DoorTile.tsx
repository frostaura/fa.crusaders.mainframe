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
    // B18. The tiles are a grid row and were sized by their own content, so a door carrying
    // two signal chips pushed its own body down and left its neighbours' scan counts at a
    // different height from its own — three cards in a row ending in three places. The card
    // now fills its grid cell, the chip row RESERVES its height whether or not there are
    // chips, and the counts block is pushed to the bottom with `mt-auto`, so the footers of
    // every tile in a row line up whatever is above them.
    <Card className="h-full">
      <article aria-labelledby={nameId} className="flex h-full flex-col space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 id={nameId} className="min-w-0 break-words text-base font-semibold">
            <Link to={`/admin/doors/${device.id}`} className="inline-flex min-h-11 items-center text-accent-strong">
              {device.name}
            </Link>
          </h3>
          <span className="min-h-7">
            <DoorChips device={device} online={online} signals={row.signals} />
          </span>
        </div>

        <p className="min-w-0 break-words text-xs text-text-muted">
          {`${device.gate_key ?? UNNAMED_GATE} · ${device.device_code}`}
        </p>

        <DoorAge at={device.last_seen_at} now={now} prefix={online ? "Heard from" : "Last heard from"} />

        <p className="border-t border-border pt-3 text-sm text-text-secondary">
          {doorStateNotice(device, online, timezone)}
        </p>

        <div className="mt-auto border-t border-border pt-3">
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
