import { Badge } from "../Button";
import { doorSetupChip, doorSignalChip, doorStateChip, type DoorChip } from "../../lib/doorsCopy";
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
  online: boolean;
  /** Empty on the detail header, where signals get their own full notices instead. */
  signals?: DoorSignal[];
}) {
  // C2: <b>Shut AND Not reporting are BOTH shown.</b> `doorStateChip` collapses them —
  // shut outranks liveness, so a door that is shut and unreachable wore only "Shut", and
  // the screen then had no way to say the thing that actually matters about it: it has not
  // heard the refusal, and it goes on admitting booked members from its saved list for up
  // to six hours. Caught by looking at a rendered overview where the banner said "2
  // confirmed, 1 not yet" over three tiles that all looked identical.
  const chips: DoorChip[] = [doorStateChip(device, online)];
  if (!device.enabled && !online) chips.push({ label: "Not reporting", tone: "danger" });
  const setup = doorSetupChip(device);
  if (setup) chips.push(setup);
  for (const signal of signals ?? []) chips.push(doorSignalChip(signal.kind));
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => <Badge key={chip.label} tone={chip.tone}>{chip.label}</Badge>)}
    </span>
  );
}
