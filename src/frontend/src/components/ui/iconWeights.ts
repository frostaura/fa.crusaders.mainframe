/**
 * The Phosphor weights the product actually draws — and therefore the only ones the build ships.
 *
 * <p>
 * Every Phosphor icon module carries all six weights (thin, light, regular, bold, fill,
 * duotone) as React elements, and a weight is chosen at render time, so no tree-shaker can drop
 * one. With ~140 icons in the entry chunk that was 219 kB of path data, a third of it for two
 * weights nothing renders. `vite.config.ts`'s `phosphorWeights` plugin strips every weight not
 * named here from each icon's definition at BUILD time (the dev server and vitest keep all six).
 * </p>
 *
 * <p>
 * <b>A weight that is used but missing here renders an EMPTY svg in production only</b> —
 * nothing throws. So `src/icons.test.ts` scans every `weight=` in the source and fails on one
 * this list does not name. Adding a weight to a use site means adding it here in the same change.
 * The watermark's light fingerprint is a CSS mask (`ui/watermark.css`), not an icon, so `light`
 * is not needed.
 * </p>
 */
export const SHIPPED_ICON_WEIGHTS = ["regular", "bold", "fill", "duotone"] as const;
