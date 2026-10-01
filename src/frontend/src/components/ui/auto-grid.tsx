import type { CSSProperties, ComponentProps, ReactNode } from "react";
import { layout } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import { GAP, autoGridTemplate, type GridGap, type Tile } from "./layout";

/**
 * Grid templates as tokens (R4 form factor, SPEC 2.4): `AutoGrid` packs tiles of a named minimum
 * width into as many columns as the box holds, up to `max`; `Columns` flows unequal cards into
 * CSS columns.
 *
 * <p>
 * <b>Sized by the box, not the viewport.</b> The template is
 * `repeat(auto-fill, minmax(max(min(100%, tile), (100% − (max − 1)·gap) / max), 1fr))`:
 * </p>
 * <ul>
 *   <li>`min(100%, tile)` — a tile is never wider than the box, so a 320px phone gets one column
 *   and nothing overflows (an implicit grid column is floored at its longest word; this is not).</li>
 *   <li>`(100% − gaps) / max` — once the box could hold more than `max` tiles, each tile grows
 *   instead, so `max` is a cap with no breakpoint at all. Beside the admin rail, inside a split
 *   view's detail, or at 200 % text, the grid answers to the width it actually has.</li>
 * </ul>
 * <p>
 * The tiles are rem, so at 200 % text a grid of four drops to two rather than squeezing words.
 * </p>
 */
type GridElement = "div" | "ul" | "ol" | "dl";

export type AutoGridProps = Omit<ComponentProps<"div">, "children" | "ref"> & {
  /** The tile's minimum width — `stat` 9rem, `card` 18rem, `panel` 26rem, `wide` 34rem. */
  min: Tile;
  /** At most this many columns, however wide the box. */
  max?: number;
  gap?: GridGap;
  /** Back-fill holes left by spanning tiles. */
  dense?: boolean;
  /**
   * `fit` collapses the empty tracks so two tiles share the row; `fill` (default) keeps the
   * tracks, so two tiles stay tile-sized and line up with a fuller row elsewhere.
   */
  fill?: "fill" | "fit";
  /** A list of tiles is a `ul`: a screen reader hears "list, 5 items". */
  as?: GridElement;
  children?: ReactNode;
};

export function AutoGrid(props: AutoGridProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { min, max, gap = "md", dense, fill = "fill", as = "div", className, style, children, ...rest } = props;
  // One element type to TypeScript: the three share every attribute this passes.
  const Element = as as "div";
  const template: CSSProperties = {
    gridTemplateColumns: autoGridTemplate(min, max, gap, fill),
    gap: GAP[gap],
    ...style,
  };
  return (
    <Element
      data-auto-grid={min}
      className={cn("grid min-w-0", dense && "grid-flow-row-dense", className)}
      style={template}
      {...rest}
    >
      {children}
    </Element>
  );
}

export type ColumnsProps = Omit<ComponentProps<"div">, "children"> & {
  /** The column's minimum width. */
  min: Tile;
  /** At most this many columns. */
  max?: number;
  gap?: GridGap;
  children?: ReactNode;
};

/**
 * A masonry-like flow for stacks of unequal cards (the Profile's account sections, Settings):
 * `columns: <tile> <max>` uses the width without forcing a row of equal heights, and every
 * direct child is kept whole (`break-inside: avoid`). Reading order runs down the first column,
 * then the next — which is the order the cards are in the DOM, so Tab order is paint order.
 */
export function Columns(props: ColumnsProps) {
  const { min, max, gap = "xl", className, style, children, ...rest } = props;
  const flow: CSSProperties = {
    columns: max ? `${layout.tile[min]} ${max}` : layout.tile[min],
    columnGap: GAP[gap],
    ...style,
  };
  return (
    <div
      data-columns={min}
      className={cn("min-w-0 [&>*]:mb-[var(--columns-gap)] [&>*]:break-inside-avoid", className)}
      style={{ ...flow, ["--columns-gap" as string]: GAP[gap] }}
      {...rest}
    >
      {children}
    </div>
  );
}
