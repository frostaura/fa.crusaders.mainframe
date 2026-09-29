/**
 * D12 — a dialog whose height changes while it is open (a stepper, a picker's tabs) is anchored
 * at the TOP from `sm` up. The default shape centres with `m-auto`, so a height change moved both
 * edges and the whole sheet jumped under the pointer; anchored, only the bottom edge moves. Below
 * `sm` it is a bottom sheet already and this changes nothing.
 */
export const TOP_ANCHORED_SHEET = "sm:mb-auto sm:mt-16";
