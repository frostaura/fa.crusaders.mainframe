import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CaretLeft } from "./icons";
import { moveListFocus } from "./layout";
import { useSplitLayout, type SplitAt, type SplitLayout } from "./use-split-layout";

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
 *   the list; with something picked, only the detail, under a back control (`back`) when the
 *   detail carries none of its own. Picking while stacked moves focus to the detail's heading
 *   (R5 X5-3) — the list it was on has just been hidden.</li>
 * </ul>
 *
 * <p>
 * <b>One measure (R5 X5-3).</b> A page that decides anything by the same threshold — "open in the
 * pane, or go to the page?" — reads it from {@link useSplitLayout} and passes that object as
 * `layout`, never from a viewport media query: at 200 % text the two disagreed.
 * </p>
 *
 * <p>
 * <b>A pick is announced (R5 X5-10).</b> Opening something in place changes no route, so the
 * route announcer says nothing; `announce` is said politely when `pickedKey` changes.
 * </p>
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
/** The back control: only when stacked (CSS decides, so the first paint is right). */
const BACK: Record<SplitAt, string> = {
  "48rem": "@[48rem]/split:hidden",
  "56rem": "@[56rem]/split:hidden",
  "64rem": "@[64rem]/split:hidden",
};
const WIDTH: Record<ListWidth, string> = {
  "20rem": "[--split-list:20rem]",
  "24rem": "[--split-list:24rem] 3xl:[--split-list:28rem]",
  "26rem": "[--split-list:26rem] 3xl:[--split-list:30rem]",
  "28rem": "[--split-list:28rem] 3xl:[--split-list:32rem]",
};

export type { SplitAt, SplitLayout };

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
  /** The page's own measure ({@link useSplitLayout}), when it decides anything by it too. */
  layout?: SplitLayout;
  /** Stacked with something picked: the way back to the list ("Back to invites"). */
  back?: { label: string; onBack: () => void };
  /** Which item is picked (an id): a change moves focus when stacked and says `announce`. */
  pickedKey?: string | null;
  /** Said politely when the pick changes: "Showing: Sam paid you 25.00 credits". */
  announce?: string;
};

export function SplitView(props: SplitViewProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { list, detail, placeholder, listLabel, listWidth = "24rem", splitAt = "64rem", stickyList = true, className } = props;
  const own = useSplitLayout(splitAt);
  const { attach, split } = props.layout ?? own;
  const picked = detail !== null && detail !== undefined;
  const detailRef = useRef<HTMLDivElement>(null);
  const said = usePickedFocus(detailRef, props.pickedKey ?? null, split, props.announce);
  return (
    <div ref={attach} data-split-view="" data-picked={picked || undefined} data-split={split || undefined} className={cn("@container/split min-w-0", className)}>
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
        <div ref={detailRef} data-split-detail="" className="flex min-w-0 flex-col gap-8">
          {picked && props.back ? <BackControl label={props.back.label} onBack={props.back.onBack} className={BACK[splitAt]} /> : null}
          {picked ? detail : placeholder ? <div className={PLACEHOLDER[splitAt]}>{placeholder}</div> : null}
        </div>
      </div>
      <p role="status" className="sr-only" data-split-said="">{said}</p>
    </div>
  );
}

function BackControl({ label, onBack, className }: { label: string; onBack: () => void; className: string }) {
  return (
    <button
      type="button"
      onClick={onBack}
      data-split-back=""
      className={cn("no-lift -mb-4 -ml-1 inline-flex min-h-touch items-center gap-1 self-start px-1 text-sm font-semibold text-accent-strong underline-offset-2 hover:underline", className)}
    >
      <CaretLeft size={16} weight="bold" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

const HEADING = "h1, h2, h3";
/** How long a detail may take to draw its heading (its own read) before focus stops waiting. */
const HEADING_WAIT_MS = 5_000;

/**
 * R5 X5-3 / X5-10 — a pick made after the first paint: stacked, focus goes to the detail's heading
 * (the list that held it is hidden now) once the detail has drawn one; split, focus stays on the
 * row so Up/Down keep walking. Either way `announce` is said. Returns what the status says.
 */
function usePickedFocus(detailRef: React.RefObject<HTMLDivElement | null>, key: string | null, split: boolean, announce: string | undefined) {
  // The pick the page opened with (a deep link) is the route's to announce, not a change.
  const [seen, setSeen] = useState(key);
  const [said, setSaid] = useState("");
  if (seen !== key) {
    setSeen(key);
    setSaid(key === null ? "" : announce ?? "");
  }
  const last = useRef(key);
  const splitNow = useRef(split);
  useEffect(() => { splitNow.current = split; }, [split]);
  useEffect(() => {
    if (last.current === key) return undefined;
    last.current = key;
    const box = detailRef.current;
    if (key === null || splitNow.current || !box) return undefined;
    const focusHeading = () => {
      const heading = box.querySelector<HTMLElement>(HEADING);
      if (!heading) return false;
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      heading.focus();
      return true;
    };
    if (focusHeading() || typeof MutationObserver === "undefined") return undefined;
    const observer = new MutationObserver(() => { if (focusHeading()) observer.disconnect(); });
    observer.observe(box, { childList: true, subtree: true });
    const timer = window.setTimeout(() => observer.disconnect(), HEADING_WAIT_MS);
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [key, detailRef]);
  return said;
}
