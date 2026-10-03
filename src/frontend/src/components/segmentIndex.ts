/**
 * Where a key moves focus, given where it is. `null` means "not this control's business".
 *
 * <p>
 * Pure and exported so the wrapping rules can be tested without a DOM — the off-by-one at
 * either end is the classic defect in a roving tabindex and it is invisible in the middle of
 * a list.
 * </p>
 */
export function nextSegmentIndex(
  key: string,
  from: number,
  count: number,
  orientation: "horizontal" | "vertical",
): number | null {
  const previous = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
  const next = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
  if (key === next) return (from + 1) % count;
  if (key === previous) return (from - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
