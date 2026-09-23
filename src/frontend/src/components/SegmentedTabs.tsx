import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

/**
 * The capsule tab control (item 9) — a real WAI-ARIA tablist, with manual activation.
 *
 * <p>
 * <b>There was no tabs primitive at all.</b> `grep -rn 'role="tablist"' src` returned nothing;
 * `SectionTabs` in `Layout` is a nav of `NavLink`s, and `/my-code`'s code switch was a 20 px
 * checkbox two screens below the fold. This is the primitive, and it owns the whole pattern so
 * that the second consumer does not reimplement half of it.
 * </p>
 *
 * <p>
 * <b>Manual activation, and it is a correctness decision rather than a taste one.</b> Arrow
 * keys move focus and do NOT select. On `/my-code` activating a segment fires
 * <code>fetchCode</code>, which is paced by a 10 s minimum gap and sits behind the auth
 * rate-limit bucket <em>shared with login</em> — so a keyboard user arrowing across an
 * auto-activating tablist could mint codes into a pacing gap and rate-limit the club's sign-in.
 * The APG names exactly this exception: manual activation where activation costs a round trip.
 * </p>
 *
 * <p>
 * <b>A disabled segment is present, dimmed and focusable — never hidden.</b> A tab that
 * vanishes teaches a member that the app is inconsistent; one that is there, dim, and says why
 * when you reach it teaches them the rule. `aria-disabled`, not `disabled`, because `disabled`
 * takes it out of the tab order and then the reason cannot be heard at all.
 * </p>
 */

export type Segment<T extends string> = {
  value: T;
  /** Short. It is a tab, not a sentence. */
  label: string;
  /** Present and dimmed, never removed. */
  disabled?: boolean;
  /** Said when focus reaches a disabled segment. Without it the dimming is the whole message. */
  disabledReason?: string;
};

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

/**
 * Whether the labels have stopped fitting side by side — measured, and measured from a
 * quantity that does not change when the answer does.
 *
 * <p>
 * <b>Two obvious measurements are both wrong, and both were tried in a real browser.</b>
 * `track.scrollWidth > track.clientWidth` never fires: the segments are flex items with
 * `min-w-0`, so they shrink and the labels wrap instead of overflowing — the control gets
 * three letters a line and reports no overflow at all. And measuring the segment's own
 * `scrollWidth` is circular: it is a function of the orientation, so a control that stacked
 * would measure "it fits now" and unstack, then measure "it does not fit" and stack, for ever.
 * </p>
 *
 * <p>
 * So each segment carries a hidden, absolutely-positioned copy of its own label with
 * `white-space: nowrap`. Out of flow, so it contributes no layout; `visibility: hidden`, so it
 * still has a box to measure. Its width is the label's NATURAL width and is the same in either
 * orientation, which is what makes the comparison stable.
 * </p>
 */
function needsStacking(track: HTMLElement | null, tabs: HTMLElement[]): boolean {
  if (!track || tabs.length === 0) return false;
  const trackStyle = getComputedStyle(track);
  const gap = parseFloat(trackStyle.columnGap) || 0;
  const available = track.clientWidth
    - (parseFloat(trackStyle.paddingLeft) || 0)
    - (parseFloat(trackStyle.paddingRight) || 0);

  let needed = gap * (tabs.length - 1);
  for (const tab of tabs) {
    const style = getComputedStyle(tab);
    const chrome = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
      + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
    const label = tab.querySelector<HTMLElement>("[data-segment-measure]");
    needed += (label?.getBoundingClientRect().width ?? 0) + chrome;
  }
  // 2 px of slack: a sub-pixel layout rounds either way, and a control that flips orientation
  // on a rounding error flips back and forth as the page reflows.
  return needed > available + 2;
}

export function SegmentedTabs<T extends string>({
  segments,
  value,
  onChange,
  label,
  panelId,
  className,
  showDisabledReasons = false,
}: {
  segments: Segment<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Names the GROUP: "Which code to show", not "Tabs". */
  label: string;
  /** The id of the tabpanel each segment controls. It must resolve to a real element. */
  panelId: (value: T) => string;
  className?: string;
  /**
   * Draw each dim segment's `disabledReason` under the control, rather than only speaking it.
   *
   * <p>
   * <b>Off by default, and on is usually the better answer.</b> A dimmed control whose reason
   * only a screen reader hears leaves every sighted member tapping a thing that does nothing —
   * which is the dead-surface defect this round exists to remove, and sighted members are
   * almost all of them. It is nonetheless a prop rather than the default because a consumer
   * with no room under the capsule cannot be broken by a prop it never passes, and the two
   * lanes that built this control shipped both behaviours before they met.
   * </p>
   *
   * <p>
   * Either way there is exactly ONE copy of the sentence and the dim tab's
   * `aria-describedby` points at it. Two copies is how the seen and the spoken drift apart.
   * </p>
   */
  showDisabledReasons?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<T, HTMLButtonElement>());
  const [vertical, setVertical] = useState(false);
  const [thumb, setThumb] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const selectedIndex = Math.max(0, segments.findIndex((s) => s.value === value));

  /**
   * The thumb's geometry is MEASURED, never a fraction of the width.
   *
   * <p>
   * Two segments are not equal width — "Booking code" and "Member code" differ — and they are
   * certainly not equal once the club's text scale moves. A `translateX(50%)` thumb looks
   * right in one screenshot and wrong on every phone that is not that one.
   * </p>
   */
  const measure = useCallback(() => {
    const track = trackRef.current;
    const active = tabRefs.current.get(value);
    if (!track || !active) return;
    setVertical(needsStacking(track, [...tabRefs.current.values()]));
    setThumb({
      x: active.offsetLeft,
      y: active.offsetTop,
      w: active.offsetWidth,
      h: active.offsetHeight,
    });
  }, [value]);

  // Layout effect, not an effect: measuring after paint means one frame with the thumb in the
  // old place, which on the first render is the thumb visibly sliding in from the wrong tab.
  useLayoutEffect(measure, [measure, segments.length]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    for (const el of tabRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [measure, segments.length]);

  const focusAt = (index: number) => {
    const target = segments[index];
    if (!target) return;
    tabRefs.current.get(target.value)?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const focusedValue = [...tabRefs.current.entries()]
      .find(([, el]) => el === document.activeElement)?.[0];
    const from = segments.findIndex((s) => s.value === focusedValue);
    if (from < 0) return;
    const to = nextSegmentIndex(e.key, from, segments.length, vertical ? "vertical" : "horizontal");
    if (to === null) return;
    // The arrow keys move focus and nothing else — see the note on manual activation above.
    // `preventDefault` because Up/Down would otherwise scroll the page out from under the
    // control the person is navigating.
    e.preventDefault();
    focusAt(to);
  };

  const activate = (segment: Segment<T>) => {
    // `aria-disabled` does not stop a click the way `disabled` does — that is the whole point
    // of choosing it — so the refusal is here rather than in the markup.
    if (segment.disabled) return;
    /*
      A tap on the ALREADY-selected segment is reported, not swallowed.

      It reads like a redundant event and is not: a consumer may DERIVE `value` from something
      other than the last tap. `/my-code` derives it from the code the server sent, so a member
      with no booking sees "Member code" selected while having chosen nothing — and tapping it
      is how she pins that choice. Swallowing the tap made the pin unreachable, which is the
      very bug the derived selection was introduced to fix, coming back in through the control.

      Idempotence belongs to the consumer: it is the only layer that knows whether acting twice
      costs anything.
    */
    onChange(segment.value);
  };

  const explained = segments.filter((s) => s.disabled && s.disabledReason);

  const track = (
    <div
      ref={trackRef}
      role="tablist"
      aria-label={label}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      onKeyDown={onKeyDown}
      className={cn(
        // The segmented look of `ui/tabs` (design-system.md, Components → tabs): a sunken track
        // whose active segment is lifted to the surface with a hairline edge and accent text.
        "relative isolate flex rounded-lg bg-bg-muted p-1",
        vertical ? "flex-col gap-1" : "flex-row gap-1",
        // Forced colours throws the capsule's fill away and leaves two words in a row; the
        // transparent boundary is what `index.css` turns into a real one.
        "border border-transparent",
        className,
      )}
    >
      {/*
        The sliding thumb. `aria-hidden` and `pointer-events-none`: it is a picture of the
        selection, and the selection itself is `aria-selected` on the button.

        `-z-10` under the labels rather than over them — a thumb painted on top makes the
        selected label the only unreadable one in the control.
      */}
      {thumb && (
        <span
          aria-hidden="true"
          data-segmented-thumb
          className="pointer-events-none absolute -z-10 rounded-md border border-border bg-bg-surface shadow-xs transition-all duration-enter ease-out motion-reduce:transition-none"
          style={{ transform: `translate(${thumb.x}px, ${thumb.y}px)`, width: thumb.w, height: thumb.h, left: 0, top: 0 }}
        />
      )}
      {segments.map((segment, index) => {
        const selected = segment.value === value;
        return (
          <button
            key={segment.value}
            ref={(el) => {
              if (el) tabRefs.current.set(segment.value, el);
              else tabRefs.current.delete(segment.value);
            }}
            type="button"
            role="tab"
            id={`segment-${panelId(segment.value)}`}
            aria-selected={selected}
            aria-controls={panelId(segment.value)}
            aria-disabled={segment.disabled || undefined}
            /*
              The reason is a DESCRIPTION, not part of the name.

              A name is what you say to reach a control by voice and what appears in a list of
              controls; "Booking code — you have no booking starting in the next two hours" is
              a sentence, not a name. A description is read after the name, when focus arrives,
              which is exactly the moment the rule needs explaining. Without it the dimming is
              the whole message, and dimming is not a message at all to somebody listening.
            */
            aria-describedby={segment.disabled && segment.disabledReason ? `${panelId(segment.value)}-why` : undefined}
            /*
              Roving tabindex — ONE stop for the whole group, which is the APG's own rule and
              the reason a tablist is not nine tab stops on a phone. The stop is the SELECTED
              tab, not the first: Tab into the control lands on what is showing.

              A disabled segment keeps -1 whatever happens, and is reached by the arrow keys,
              which is how its reason gets heard at all.
            */
            tabIndex={index === selectedIndex ? 0 : -1}
            onClick={() => activate(segment)}
            onKeyDown={(e) => {
              // Enter and Space activate the FOCUSED tab. A <button> does this for Enter and
              // Space by itself through `click`, so this exists only to stop Space scrolling
              // the page on the way.
              if (e.key === " ") e.preventDefault();
            }}
            onKeyUp={(e) => { if (e.key === " ") activate(segment); }}
            className={cn(
              // 44px — the `touch` size, which does not scale with the text (B12: a touch target
              // is a fingertip). `min-h`, not `h`, so a stacked segment can be taller.
              "relative z-10 flex-1 min-w-0 min-h-touch px-3 rounded-md text-sm font-semibold",
              "inline-flex items-center justify-center gap-1.5 text-center break-words",
              "border border-transparent transition-colors duration-base ease-standard",
              // A capsule whose segments rise under a thumb is a capsule that wobbles.
              "no-lift",
              selected ? "text-accent-strong" : "text-text-secondary hover:text-text-primary",
              segment.disabled && "opacity-60",
            )}
          >
            {segment.label}
            {/*
              The label again, out of flow, never wrapped — the only thing on this control
              whose width is the same whichever orientation it is in. See `needsStacking`.
              `absolute` keeps it out of the layout; `invisible` is `visibility: hidden`,
              which still has a box to measure where `display: none` would not.
            */}
            <span
              aria-hidden="true"
              data-segment-measure
              className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap"
            >
              {segment.label}
            </span>
          </button>
        );
      })}
      {/*
        The reasons, OUTSIDE every button.

        Putting the sentence inside the `<button>` would have made it part of the accessible
        NAME — content-based naming concatenates everything in the element — which is the
        opposite of the point, and is the same defect a confirm button in this repo already
        shipped once with its name made of every copy of its label. Out here it is only ever a
        description, read when focus arrives.

        Inside the tablist while they are invisible, because a `role="tablist"` whose children
        are not all tabs is still a valid tablist and a zero-size span disturbs no layout.
        `aria-hidden` so the invisible copy is a description and never page content as well.
      */}
      {!showDisabledReasons && explained.map((s) => (
        <span key={`${s.value}-why`} id={`${panelId(s.value)}-why`} className="sr-only" aria-hidden="true">
          {s.disabledReason}
        </span>
      ))}
    </div>
  );

  if (!showDisabledReasons || explained.length === 0) return track;

  /*
    Drawn: the same single sentence, out of the flex row and under the control.

    It leaves the tablist because a paragraph among flex children is laid out AS a segment —
    it would take a share of the row and stretch the capsule round it. And the `aria-hidden`
    comes off with the `sr-only`: visible text that a screen reader is forbidden to reach as
    page content is a second class of invisible, and the description reference still finds it.
  */
  return (
    <div className="space-y-1.5">
      {track}
      {explained.map((s) => (
        <p key={`${s.value}-why`} id={`${panelId(s.value)}-why`} className="text-xs text-text-muted">
          {s.disabledReason}
        </p>
      ))}
    </div>
  );
}

/**
 * The panel a segment controls.
 *
 * <p>
 * Its own component because two of its three attributes are the ones that get forgotten, and
 * forgetting either is silent: without `aria-labelledby` the panel is an unnamed region, and
 * without <code>tabIndex={0}</code> a screen-reader user Tabbing out of the single-stop
 * tablist lands PAST the content the tabs exist to show.
 * </p>
 */
export function SegmentedTabPanel({
  id, tabId, children, className,
}: { id: string; tabId?: string; children: React.ReactNode; className?: string }) {
  return (
    <div
      id={id}
      role="tabpanel"
      aria-labelledby={tabId ?? `segment-${id}`}
      tabIndex={0}
      // No `outline-none`: a focusable panel shows the house `:focus-visible` outline like
      // everything else that takes focus.
      className={className}
    >
      {children}
    </div>
  );
}
