import type { FilterOption } from "@/components/monitoring/parts";
import { doorDisplayName } from "@/lib/doorsCopy";
import { DOORS_TAB_COPY as COPY } from "@/lib/memberDetailCopy";

/** A door as the filter needs it: its id, its given name and the board's own code. */
type DoorChoice = { device: { id: string; name: string; device_code: string } };

/** The options themselves, each door by the one name every door surface uses (R8, E7-4 rest: not "Door gate"). */
export function doorOptions(doors: readonly DoorChoice[]): FilterOption[] {
  return [
    { value: "", label: COPY.anyDoor },
    ...doors.map((d) => ({ value: d.device.id, label: doorDisplayName(d.device) })),
  ];
}
