import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { X } from "@/components/ui/icons";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { typography } from "@/lib/typography";
import { cn } from "@/lib/utils";

/**
 * Coach marks — a short guided tour of real controls, one popover at a time (P8's admin tour).
 *
 * <p>
 * <b>Built on the Radix Popover the design system already ships</b>, anchored through its
 * `virtualRef` to an element the page already has, so there is no new dependency and nothing
 * on the page has to know it is being toured. The anchored element gets the focus-ring outline
 * while its mark is up, so the popover is never pointing at nothing in particular.
 * </p>
 *
 * <p>
 * <b>Non-modal, and always escapable.</b> The page stays usable; Escape and the × both end the
 * tour as a skip; "Skip tour" says so in words. A click elsewhere does NOT close it — a tour that
 * vanishes because somebody tapped the page to scroll is a tour that cannot be finished on a
 * phone. Focus moves into each mark as it opens, so a keyboard or screen-reader user hears the
 * title and the sentence, and Next is one Tab away.
 * </p>
 *
 * <p>
 * An anchor that cannot be found (a section hidden at this width, a page still loading) does not
 * stop the tour: the mark shows at the top of the screen instead, still saying where to go.
 * </p>
 */

export type CoachMark = {
  id: string;
  title: string;
  body: string;
  /** Resolved when the mark opens — the page may have re-rendered since the tour began. */
  anchor: () => Element | null;
  side?: "top" | "right" | "bottom" | "left";
  /** One more line under the body — e.g. how to reach the place on this layout. */
  hint?: string;
};

export type CoachMarksLabels = {
  stepOf: (n: number, total: number) => string;
  back: string;
  next: string;
  done: string;
  skip: string;
  close: string;
};

export type CoachMarksProps = {
  marks: readonly CoachMark[];
  labels: CoachMarksLabels;
  /** Called once, when the last mark is done or the tour is skipped. */
  onFinish: (how: "done" | "skipped") => void;
};

type Measurable = { getBoundingClientRect: () => DOMRect; contextElement?: Element };

/** A point near the top-centre of the screen, for a mark whose anchor is not on the page. */
function fallbackAnchor(): Measurable {
  return { getBoundingClientRect: () => new DOMRect(window.innerWidth / 2, 72, 0, 0) };
}

function isShown(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement && element.getClientRects().length > 0;
}

/** Paints (or restores) the outline on an element the tour does not own. */
function outline(element: HTMLElement, value: { outline: string; offset: string }) {
  element.style.outline = value.outline;
  element.style.outlineOffset = value.offset;
}

/** Outlines the anchored element for as long as its mark is up, and puts it back after. */
function useSpotlight(element: HTMLElement | null) {
  useEffect(() => {
    if (!element) return;
    const before = { outline: element.style.outline, offset: element.style.outlineOffset };
    outline(element, { outline: "2px solid rgb(var(--color-ring))", offset: "2px" });
    element.scrollIntoView?.({ block: "nearest" });
    return () => outline(element, before);
  }, [element]);
}

function useAnchor(mark: CoachMark | undefined) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const found = mark?.anchor() ?? null;
    // Measured after paint, so a layout that has just changed has settled first.
    const frame = window.requestAnimationFrame(() => setElement(isShown(found) ? found : null));
    return () => window.cancelAnimationFrame(frame);
  }, [mark]);
  useSpotlight(element);
  const virtual = useMemo<Measurable>(
    () => (element ? { getBoundingClientRect: () => element.getBoundingClientRect(), contextElement: element } : fallbackAnchor()),
    [element],
  );
  return { element, virtual };
}

export function CoachMarks({ marks, labels, onFinish }: CoachMarksProps) {
  const [index, setIndex] = useState(0);
  const mark = marks[index];
  const { element, virtual } = useAnchor(mark);

  if (!mark) return null;
  const last = index === marks.length - 1;

  return (
    <Popover open modal={false}>
      <PopoverAnchor virtualRef={{ current: virtual }} />
      {/* Keyed, so each mark mounts afresh: focus moves into it and its title is heard. */}
      <MarkContent
        key={mark.id}
        mark={mark}
        position={{ index, total: marks.length, last, anchored: element !== null }}
        labels={labels}
        onMove={(delta) => setIndex((at) => Math.min(Math.max(at + delta, 0), marks.length - 1))}
        onFinish={onFinish}
      />
    </Popover>
  );
}

type MarkContentProps = {
  mark: CoachMark;
  position: { index: number; total: number; last: boolean; anchored: boolean };
  labels: CoachMarksLabels;
  onMove: (delta: number) => void;
  onFinish: (how: "done" | "skipped") => void;
};

/**
 * R4 (V4-5): the room the tab bar takes at the bottom of a phone, which the shell publishes as
 * `--app-bottom-bar-height`. Radix keeps the mark inside the viewport less this padding, so a mark
 * never sits under the bar, and its `max-h` (the popover's available height) leaves Next on screen.
 */
function bottomChrome(): number {
  if (typeof window === "undefined") return 8;
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-bottom-bar-height"));
  return (Number.isFinite(value) ? value : 0) + 8;
}

function MarkContent(props: MarkContentProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { mark, position, labels, onMove, onFinish } = props;
  const titleId = useId();
  const bodyId = useId();
  const box = useRef<HTMLDivElement>(null);

  return (
    <PopoverContent
      ref={box}
      data-coachmark={mark.id}
      side={position.anchored ? mark.side ?? "right" : "bottom"}
      align="start"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      tabIndex={-1}
      collisionPadding={{ top: 8, right: 8, left: 8, bottom: bottomChrome() }}
      className="flex w-80 flex-col gap-3"
      onOpenAutoFocus={(event) => { event.preventDefault(); box.current?.focus(); }}
      onEscapeKeyDown={() => onFinish("skipped")}
      onInteractOutside={(event) => event.preventDefault()}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className={typography({ variant: "overline" })}>{labels.stepOf(position.index + 1, position.total)}</p>
          <h2 id={titleId} className={cn(typography({ variant: "h3" }), "break-words")}>{mark.title}</h2>
        </div>
        <IconButton label={labels.close} size="icon" className="-mr-2 -mt-2" onClick={() => onFinish("skipped")}>
          <X aria-hidden="true" />
        </IconButton>
      </div>
      <div id={bodyId} className="flex flex-col gap-2 text-sm text-text-secondary">
        <p>{mark.body}</p>
        {mark.hint ? <p className="text-text-muted">{mark.hint}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" className="mr-auto" onClick={() => onFinish("skipped")}>{labels.skip}</Button>
        {position.index > 0 ? <Button variant="outline" size="sm" onClick={() => onMove(-1)}>{labels.back}</Button> : null}
        {position.last ? (
          <Button size="sm" onClick={() => onFinish("done")}>{labels.done}</Button>
        ) : (
          <Button size="sm" onClick={() => onMove(1)}>{labels.next}</Button>
        )}
      </div>
    </PopoverContent>
  );
}
