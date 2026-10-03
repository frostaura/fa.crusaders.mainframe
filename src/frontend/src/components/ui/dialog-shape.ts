/**
 * D12 — a dialog whose height changes while it is open (a stepper, a picker's tabs) is anchored
 * at the TOP from `sm` up. The default shape centres with `m-auto`, so a height change moved both
 * edges and the whole sheet jumped under the pointer; anchored, only the bottom edge moves. Below
 * `sm` it is a bottom sheet already and this changes nothing.
 */
/*
 * R8 L8-12 — the top is `--dialog-top` (`dialog.tsx` useOpenCentred): centred when it opens, then
 * held; a rem from the window's edges at least, and never taller than the window less those two
 * rems — at 200 % text the old `mt-16` + 85dvh ran the Book dialog to 808 of an 800px window.
 */
export const TOP_ANCHORED_SHEET = "sm:mb-auto sm:mt-[var(--dialog-top,4rem)] sm:max-h-[calc(100dvh-2rem)]";
