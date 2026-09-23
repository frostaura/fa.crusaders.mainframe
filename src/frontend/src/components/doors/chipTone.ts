import type { DoorChip } from "../../lib/doorsCopy";

/**
 * A door chip's tone as the design-system Badge names it. The copy layer still says "muted"
 * (it predates the Badge's vocabulary, and its tests pin it); the Badge calls that "neutral".
 */
export function chipTone(tone: DoorChip["tone"]): "success" | "danger" | "neutral" | "warning" {
  return tone === "muted" ? "neutral" : tone;
}
