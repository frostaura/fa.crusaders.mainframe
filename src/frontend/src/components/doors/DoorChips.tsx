import { Badge } from "../ui/badge";
import { chipTone } from "./chipTone";
import {
  doorSetupChip, doorShutHeard, doorSignalChip, doorStateChip, type DoorChip,
} from "../../lib/doorsCopy";
import { type AdminDoorDevice, type DoorSignal } from "../../lib/api";

/**
 * The chips on a door, in one place so the tile and the detail header cannot drift.
 *
 * <p>
 * <b>Two dimensions, then the signals.</b> Liveness first, because it is the question the
 * page exists to answer; then the setup chip, which fires on a missing NAME rather than on
 * the new-board flag, because a missing name has a consequence an admin can act on; then any
 * signals, which are a reading of recent events and never a state.
 * </p>
 *
 * <p>
 * Every chip is a WORD. Colour alone is never the signal here, and the four pairs these
 * tones resolve to are measured in `src/tokens.test.ts`.
 * </p>
 */
export function DoorChips({ device, online, signals }: {
  device: AdminDoorDevice;
  /** `null` = this page cannot currently say (A8). No liveness chip is drawn at all then. */
  online: boolean | null;
  /** Empty on the detail header, where signals get their own full notices instead. */
  signals?: DoorSignal[];
}) {
  // C2: <b>Shut AND Not reporting are BOTH shown.</b> `doorStateChip` collapses them —
  // shut outranks liveness, so a door that is shut and unreachable wore only "Shut", and
  // the screen then had no way to say the thing that actually matters about it: it has not
  // heard the refusal, and it goes on admitting booked members from its saved list for up
  // to six hours. Caught by looking at a rendered overview where the banner said "2
  // confirmed, 1 not yet" over three tiles that all looked identical.
  const state = doorStateChip(device, online);
  const chips: DoorChip[] = state ? [state] : [];
  // R3-1: a shut door's SECOND chip is about whether it has been told, not about whether it
  // is reporting — and those were the same chip while the shut itself froze `last_seen_at`.
  // A door that heard the shut and has since gone quiet wore "Not reporting" beside "Shut"
  // and sent an admin to look at a board that was refusing everybody exactly as asked.
  const heard = doorShutHeard(device);
  if (!device.enabled && heard.state === "confirmed") chips.push({ label: "Told", tone: "success" });
  else if (!device.enabled && heard.state === "not_told") chips.push({ label: "Not told yet", tone: "warning" });
  else if (!device.enabled && online === false) chips.push({ label: "Not reporting", tone: "danger" });
  const setup = doorSetupChip(device);
  if (setup) chips.push(setup);
  // B9 / A9: a signal chip is a reading of recent scans, and on a shut or unreachable door
  // those scans are refusals the club caused or scans the club has not seen. The chip goes
  // with its explanation rather than surviving on its own.
  if (device.enabled && online === true) {
    for (const signal of signals ?? []) chips.push(doorSignalChip(signal.kind));
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {/*
        <b>C-M7 / R3-26 — the chips that carry a door's whole state were bare spans.</b>

        The log's rows have said "Outcome: Refused" to a screen reader since B17. Tabbing the
        overview read "Side door. Shut. Not told yet." as three unattached words with nothing
        saying what kind of fact any of them was.

        It labels the group from BESIDE the badges rather than from inside the first one.
        Inside, the prefix becomes part of that badge's own text — the badge then reads
        "Status: Reporting" to every exact text query in the suite and to speech control,
        which is the WCAG 2.5.3 failure `ConfirmButton` documents at length, one component
        along. Said once rather than before each of three chips, which is the noise that
        teaches somebody to skip the row.
      */}
      <span className="sr-only">Status: </span>
      {chips.map((chip) => <Badge key={chip.label} tone={chipTone(chip.tone)}>{chip.label}</Badge>)}
    </span>
  );
}
