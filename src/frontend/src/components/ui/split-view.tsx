import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { moveListFocus } from "./layout";

/**
 * Master–detail (R4 form factor, SPEC 2.2): a list beside the thing picked from it — invites,
 * notifications, members, schedules.
 *
 * <p>
 * <b>Routing stays as it is.</b> The caller decides what is selected — a child route's
 * `<Outlet/>`, or a `?param` — and passes it as `detail`; `null` means nothing is picked. Deep
 * links, Back and history keep working with no new routes.
 * </p>
 *
 * <ul>
 *   <li><b>Split</b> (the BOX ≥ `splitAt`, 64rem by default): `[list] [detail]`. The list pane
 *   sticks under the top of the scroller and scrolls itself, so its position survives a long
 *   detail; the detail scrolls with the page. Nothing picked shows the `placeholder` — a quiet
 *   state plus the summary that matters for that list.</li>
 *   <li><b>Stacked</b> (narrower, or 200 % text — the threshold is rem): with nothing picked, only
 *   the list; with something picked, only the detail (which carries its own back link). That is
 *   the phone's behaviour today, unchanged.</li>
 * </ul>
 *
 * <p>
 * <b>CSS decides, not JavaScript.</b> Both panes are always mounted and a container query hides
 * the one a stacked layout does not show, so the first paint is right at every width, nothing
 * flickers from one shape to the other, and the list keeps its filters and scroll in React state
 * while a phone shows the detail.
 * </p>
 *
 * <p>
 * <b>The list is walked with the arrow keys.</b> Up/Down (and Home/End) move focus between the
 * list's `[data-split-item]` elements while focus is in the list; Enter opens one, because each is
 * a link or a button. The picked row carries `aria-current="page"` (a `NavLink` does it for free).
 * </p>
 */
type SplitAt = "48rem" | "56rem" | "64rem";
type ListWidth = "20rem" | "24rem" | "26rem" | "28rem";

/** Every class written whole, so Tailwind's scanner sees it. */
const GRID: Record<SplitAt, string> = {
  "48rem": "@[48rem]/split:grid @[48rem]/split:grid-cols-[var(--split-list)_minmax(0,1fr)] @[48rem]/split:items-start @[48rem]/split:gap-8",
  "56rem": "@[56rem]/split:grid @[56rem]/split:grid-cols-[var(--split-list)_minmax(0,1fr)] @[56rem]/split:items-start @[56rem]/split:gap-8",
  "64rem": "@[64rem]/split:grid @[64rem]/split:grid-cols-[var(--split-list)_minmax(0,1fr)] @[64rem]/split:items-start @[64rem]/split:gap-8",
};
/** The list while a detail is open: hidden when stacked. */
const LIST_WITH_DETAIL: Record<SplitAt, string> = {
  "48rem": "hidden @[48rem]/split:flex",
  "56rem": "hidden @[56rem]/split:flex",
  "64rem": "hidden @[64rem]/split:flex",
};
const PLACEHOLDER: Record<SplitAt, string> = {
  "48rem": "hidden @[48rem]/split:block",
  "56rem": "hidden @[56rem]/split:block",
  "64rem": "hidden @[64rem]/split:block",
};
const STICKY: Record<SplitAt, string> = {
  "48rem": "@[48rem]/split:sticky @[48rem]/split:top-6 @[48rem]/split:max-h-[calc(100dvh-var(--app-chrome-height,0px)-3rem)] @[48rem]/split:overflow-y-auto",
  "56rem": "@[56rem]/split:sticky @[56rem]/split:top-6 @[56rem]/split:max-h-[calc(100dvh-var(--app-chrome-height,0px)-3rem)] @[56rem]/split:overflow-y-auto",
  "64rem": "@[64rem]/split:sticky @[64rem]/split:top-6 @[64rem]/split:max-h-[calc(100dvh-var(--app-chrome-height,0px)-3rem)] @[64rem]/split:overflow-y-auto",
};
const WIDTH: Record<ListWidth, string> = {
  "20rem": "[--split-list:20rem]",
  "24rem": "[--split-list:24rem] 3xl:[--split-list:28rem]",
  "26rem": "[--split-list:26rem] 3xl:[--split-list:30rem]",
  "28rem": "[--split-list:28rem] 3xl:[--split-list:32rem]",
};

export type SplitViewProps = {
  list: ReactNode;
  /** What is picked, or null for nothing. */
  detail: ReactNode | null;
  /** Shown beside the list when nothing is picked (split only). */
  placeholder?: ReactNode;
  /** Names the list pane: "Invites", "Notifications". */
  listLabel: string;
  listWidth?: ListWidth;
  splitAt?: SplitAt;
  stickyList?: boolean;
  className?: string;
};

export function SplitView(props: SplitViewProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { list, detail, placeholder, listLabel, listWidth = "24rem", splitAt = "64rem", stickyList = true, className } = props;
  const picked = detail !== null && detail !== undefined;
  return (
    <div data-split-view="" data-picked={picked || undefined} className={cn("@container/split min-w-0", className)}>
      <div className={cn("flex flex-col gap-8", WIDTH[listWidth], GRID[splitAt])}>
        <div
          role="region"
          aria-label={listLabel}
          data-split-list=""
          onKeyDown={moveListFocus}
          className={cn(
            "min-w-0 flex-col gap-4",
            picked ? LIST_WITH_DETAIL[splitAt] : "flex",
            // Room for a focus outline inside the pane's own scroller.
            stickyList && cn(STICKY[splitAt], "overscroll-contain p-1 -m-1"),
          )}
        >
          {list}
        </div>
        <div data-split-detail="" className="flex min-w-0 flex-col gap-8">
          {picked ? detail : placeholder ? <div className={PLACEHOLDER[splitAt]}>{placeholder}</div> : null}
        </div>
      </div>
    </div>
  );
}
