import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";

/**
 * A capsule tab control — GOAL item 9, D4 §5.7.
 *
 * <p>
 * <b>MERGE NOTE — this is a local stand-in for the UI lane's `components/SegmentedTabs.tsx`,
 * written to D4's API character for character.</b> When that primitive lands, this file
 * becomes one line — <code>export { SegmentedTabs, type Segment } from "../SegmentedTabs";</code>
 * — and nothing at the call site changes. It is here rather than absent because the two lanes
 * are separate branches: `/my-code` cannot type-check, test or be walked in a browser against
 * a file that is not in this worktree, and shipping the page's fix behind another lane's merge
 * is how a fix arrives a week late.
 * </p>
 *
 * <p>
 * <b>What it owns:</b> roving `tabindex`, arrow / Home / End, <b>manual</b> activation, a
 * measured thumb, the vertical flip, a 44 px floor in pixels, and `border border-transparent`
 * so a boundary survives `forced-colors: active`. It owns nothing about codes.
 * </p>
 *
 * <p>
 * <b>One deliberate departure from D4's sketch, to carry across at merge:</b> a
 * `disabledReason` is rendered VISIBLY under the tablist rather than `sr-only`. A dimmed
 * control whose reason only a screen reader hears is the dead-surface defect the design set
 * out to remove. If the shared primitive hides it instead, the sentence moves into
 * `CodeChoice` and the tab keeps its `aria-describedby`.
 * </p>
 *
 * <p>
 * <b>Manual activation is a correctness decision, not a taste one.</b> Activating on arrow
 * would fire a code fetch per keypress; that endpoint sits behind the API's auth rate-limit
 * bucket, which is <i>shared with login</i> (`useMemberCode.ts` records this), and is paced at
 * one call per ten seconds. A keyboard user arrowing across two tabs would mint codes into a
 * pacing gap and could rate-limit the club's sign-in. The APG names exactly this exception.
 * </p>
 */

export type Segment<T extends string> = {
  value: T;
  /** Short. It is a tab, not a sentence. */
  label: string;
  /** Present and dimmed, never removed. The reason is announced when focus reaches it. */
  disabled?: boolean;
  disabledReason?: string;
};

/**
 * The thumb's geometry, measured from the buttons rather than computed from a fraction.
 *
 * <p>
 * This repo has been bitten twice by a guessed length — `top-[100px]` for the toast and
 * `5rem` for a heading offset, both correct at a 16 px root and wrong at 32 px. Two segments
 * are not equal width ("Booking code" and "Member code" differ by a letter's worth), and they
 * are certainly not equal once the club's text scale moves.
 * </p>
 */
type Thumb = { x: number; y: number; width: number; height: number } | null;

export function SegmentedTabs<T extends string>({
  segments, value, onChange, label, panelId, className,
}: {
  segments: Segment<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Names the GROUP. "Which code to show", not "Tabs". */
  label: string;
  /** id of the tabpanel each segment controls. */
  panelId: (value: T) => string;
  className?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const tabs = useRef(new Map<T, HTMLButtonElement>());
  const [thumb, setThumb] = useState<Thumb>(null);
  /**
   * Above roughly a 24 px root font the two labels stop fitting side by side. The control then
   * stacks — and it changes honestly: a vertical tablist is still a tablist, still announces as
   * one, and its arrow keys become Up/Down per the APG.
   */
  const [vertical, setVertical] = useState(false);

  const measure = useCallback(() => {
    const box = list.current;
    const active = tabs.current.get(value);
    if (!box || !active) return;
    const outer = box.getBoundingClientRect();
    const inner = active.getBoundingClientRect();
    setThumb({
      x: inner.left - outer.left,
      y: inner.top - outer.top,
      width: inner.width,
      height: inner.height,
    });
    // Stacked when the segments have wrapped onto different lines — read off the laid-out
    // boxes rather than off a breakpoint, because what decides it is the text scale.
    const rects = [...tabs.current.values()].map((el) => el.getBoundingClientRect());
    setVertical(rects.length > 1 && rects.some((r) => Math.abs(r.top - rects[0].top) > 1));
  }, [value]);

  // Layout effect: the thumb must be in place on the first paint that shows the selection,
  // not one frame after it, or it visibly slides in from the left on every mount.
  useLayoutEffect(measure, [measure, segments.length]);

  useEffect(() => {
    const box = list.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    for (const el of tabs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [measure, segments.length]);

  /** Arrow / Home / End move focus. They never activate — see the class comment. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const order = segments.map((s) => s.value);
    const here = order.indexOf(value);
    const focused = order.findIndex((v) => tabs.current.get(v) === document.activeElement);
    const from = focused >= 0 ? focused : here;
    const back = vertical ? "ArrowUp" : "ArrowLeft";
    const forward = vertical ? "ArrowDown" : "ArrowRight";
    let next: number | null = null;
    if (event.key === back) next = (from - 1 + order.length) % order.length;
    else if (event.key === forward) next = (from + 1) % order.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = order.length - 1;
    if (next === null) return;
    event.preventDefault();
    tabs.current.get(order[next])?.focus();
  };

  const dimmed = segments.filter((s) => s.disabled && s.disabledReason);

  return (
    <div className={cn("space-y-1", className)}>
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      onKeyDown={onKeyDown}
      className={cn(
        "relative flex flex-wrap gap-1 rounded-xl bg-bg-muted p-1",
        // `border border-transparent`: under forced-colors every author fill is thrown away,
        // and a capsule with no boundary is two words floating in a paragraph.
        "border border-transparent",
      )}
    >
      {/*
        The thumb. Measured, never a fraction of the width. `aria-hidden` because the selected
        state is already carried by `aria-selected` — a second announcement of the same fact is
        the defect Toast.tsx records paying for.
      */}
      {thumb && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute rounded-lg bg-bg-surface shadow-sm transition-[transform,width,height] duration-base motion-reduce:transition-none"
          style={{
            width: thumb.width,
            height: thumb.height,
            transform: `translate(${thumb.x}px, ${thumb.y}px)`,
            left: 0,
            top: 0,
          }}
        />
      )}
      {segments.map((segment) => {
        const selected = segment.value === value;
        return (
          <button
            key={segment.value}
            ref={(el) => {
              if (el) tabs.current.set(segment.value, el);
              else tabs.current.delete(segment.value);
            }}
            type="button"
            role="tab"
            id={`tab-${segment.value}`}
            aria-selected={selected}
            aria-controls={panelId(segment.value)}
            /*
              `aria-disabled`, NEVER `disabled`. A tab that vanishes teaches a member the app
              is inconsistent; a `disabled` one is a hole in the tab order that explains
              nothing. Present, dimmed, focusable, and it says why when focus reaches it.
            */
            aria-disabled={segment.disabled || undefined}
            aria-describedby={segment.disabled && segment.disabledReason ? `tab-${segment.value}-why` : undefined}
            // Roving: one tab stop for the whole group, whichever segment is selected.
            tabIndex={selected ? 0 : -1}
            onClick={() => { if (!segment.disabled) onChange(segment.value); }}
            className={cn(
              // 44px in PIXELS, not rem: a touch target is a fingertip and does not scale
              // with the club's text setting.
              "no-lift relative z-10 min-h-[44px] flex-1 basis-[7rem] rounded-lg border border-transparent px-3",
              "text-sm font-medium transition-colors duration-base",
              selected ? "text-text-primary" : "text-text-secondary",
              segment.disabled && "opacity-60",
            )}
          >
            {segment.label}
          </button>
        );
      })}
    </div>
    {/*
      <b>The reason lives OUTSIDE the button, and it is visible.</b> Inside it, the segment's
      accessible name becomes "Booking code The club has no booking of yours to make a code
      for at the moment…" — which is C17's finding word for word, on a new control: a
      screen-reader user hears a paragraph read out as the name of a tab, every time, with no
      way to skip to the state. As `aria-describedby` it is announced after the name and the
      state, and can be interrupted.

      And it is drawn rather than `sr-only`, because a dimmed control with no visible reason
      is the dead-surface defect this design set out to remove — a member taps it and nothing
      at all happens. One copy serves both readers; two copies is the duplication the page
      already pays for elsewhere.
    */}
    {dimmed.map((segment) => (
      <p key={segment.value} id={`tab-${segment.value}-why`} className="text-xs text-text-muted">
        {segment.disabledReason}
      </p>
    ))}
    </div>
  );
}
