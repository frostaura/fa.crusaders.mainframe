import { Link } from "react-router-dom";
import { Panel as Card } from "../ui/card";
import { DoorAge } from "./DoorAge";
import { DoorChips } from "./DoorChips";
import {
  doorDisplayName, doorScanCountHeading, doorScanCountLine, doorSignalLine, doorStateNotice,
  type SignalNumbers,
} from "../../lib/doorsCopy";
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
export function DoorTile({ row, now, online, timezone, dayStartedAt, settings }: {
  row: DoorRow;
  now: number;
  /**
   * Whether this door is reporting — or <b>null, meaning this page cannot currently say</b>.
   *
   * A8: with the admin's own phone off the network, every age went on ticking from a frozen
   * read and doors flipped one by one to "Not reporting" while the page asserted "nothing can
   * reach it". The thing that could not reach anything was the browser. The liveness verdict
   * is resolved by the page, once, from the state of its own reads — not re-derived here.
   */
  online: boolean | null;
  timezone: string;
  dayStartedAt: string;
  /** The club's own numbers, for A9's signal line. Nulls where the settings read failed. */
  settings: SignalNumbers;
}) {
  const device = row.device;
  // A11: "Door gate" is the placeholder `DeviceRegistryService` gives every gate that
  // registers itself. Presenting it as the club's own word for one board named none of the
  // five in the same state.
  const name = doorDisplayName(device);
  const nameId = `door-${device.id}-name`;
  // A9 / B9: the chips are explained HERE, where an admin first meets them — and they are
  // suppressed outright for a shut or unreachable door, where "usually a dirty scanner" is
  // advice about a question nobody is asking.
  const signalLines = row.signals
    .map((signal) => doorSignalLine(device, online, signal, settings))
    .filter((line): line is NonNullable<typeof line> => line !== null);
  return (
    // B18. The tiles are a grid row and were sized by their own content, so a door carrying
    // two signal chips pushed its own body down and left its neighbours' scan counts at a
    // different height from its own — three cards in a row ending in three places. The card
    // now fills its grid cell, the chip row RESERVES its height whether or not there are
    // chips, and the counts block is pushed to the bottom with `mt-auto`, so the footers of
    // every tile in a row line up whatever is above them.
    <Card className="h-full">
      <article aria-labelledby={nameId} className="flex h-full flex-col space-y-3">
        {/*
          <b>B14, and the correction the look pass forced on it.</b>

          The header was `flex-wrap … justify-between`, so whether the chips sat beside the
          name or wrapped under it depended on how long the name happened to be — at tablet
          width a club's four cards showed four different header layouts, and an admin
          scanning them had to find the state chip in a different place on each. B14 made it
          a two-column grid.

          That grid painted a chip ON TOP of the name at 320 px with a 32 px root font — the
          large-text setting an older volunteer actually uses. "Sid[Reporting]e door", over
          the one control a card exists to offer. A grid has fixed tracks, so with the chips
          alone wider than the card there was nowhere for them to go: the name column
          (correctly `minmax(0,1fr)`) collapsed to nothing and its text spilled out
          underneath. Making the chip track shrinkable did not help — a badge is one
          unbreakable word, and its min-content width is what it is.

          Neither did letting the header wrap on demand, which is B14 coming straight back:
          a card with two chips wrapped and its neighbour with one did not, so three cards in
          a row laid out three ways again.

          So the chips have a row of their own, always. Every card is laid out identically at
          every text size — which is what B14 actually asked for, more completely than the
          grid delivered — and two boxes that are never on the same line cannot collide. The
          reading order is the honest one as well: the door, then what is true of it.
        */}
        <div className="space-y-2">
          <h3 id={nameId} className="min-w-0 break-words text-base font-semibold">
            {/*
              A13: `min-w-11`. A door called "A" gave a 34 px link — under the 44 px target
              this whole surface is built to, on the one control a card exists to offer, and
              the shorter the name the smaller the target got. The padding is inside the link
              so the hit area grows rather than the text.
            */}
            <Link
              to={`/admin/monitoring/doors/${device.id}`}
              className="inline-flex min-h-11 min-w-11 items-center justify-start text-accent-strong"
            >
              {name}
            </Link>
          </h3>
          {/* The height is reserved whether or not there are chips, so a door with two and
              its neighbour with none still line their bodies up (B18's family). */}
          <div className="min-h-7">
            <DoorChips device={device} online={online} signals={row.signals} />
          </div>
        </div>

        <p className="min-w-0 break-words text-xs text-text-muted">
          {`${device.gate_key ?? UNNAMED_GATE} · ${device.device_code}`}
        </p>

        <DoorAge at={device.last_seen_at} now={now} prefix={online === true ? "Heard from" : "Last heard from"} />

        {/* A8: null while this page cannot say — the explanation is on the page once, above
            the cards, rather than repeated on every one of them. */}
        {doorStateNotice(device, online, timezone) && (
          <p className="border-t border-border pt-3 text-sm text-text-secondary">
            {doorStateNotice(device, online, timezone)}
          </p>
        )}

        {/* A9: one line of explanation, and the action, beside the chip that raised it. The
            chip alone taught an admin nothing they could act on. */}
        {signalLines.map((line) => (
          <div key={line.text} className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning-strong">
            <p>{line.text}</p>
            {line.settingHash ? (
              <Link
                to={`/admin/settings${line.settingHash}`}
                className="mt-1 inline-flex min-h-11 items-center font-medium underline"
              >
                {`${line.action} — ${name}`}
              </Link>
            ) : (
              <Link
                to={`/admin/monitoring/doors/log?door=${encodeURIComponent(device.id)}&outcome=refused`}
                className="mt-1 inline-flex min-h-11 items-center font-medium underline"
              >
                {`${line.action} — ${name}`}
              </Link>
            )}
          </div>
        ))}

        <div className="mt-auto border-t border-border pt-3">
          <p className="text-xs text-text-muted">{doorScanCountHeading(dayStartedAt, timezone)}</p>
          <p className="text-sm text-text-secondary">{doorScanCountLine(row.today, online)}</p>
          {device.running_version && (
            <p className="mt-1 text-xs text-text-muted">{`firmware ${device.running_version}`}</p>
          )}
        </div>
      </article>
    </Card>
  );
}
