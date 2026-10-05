import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { typography } from "../lib/typography";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { CaretLeft, CaretRight } from "./ui/icons";

export type CarouselSlide = { key: string; title?: string; node: ReactNode };

/**
 * Mobile-first horizontal carousel — native scroll-snap, so a swipe is free, with arrow buttons
 * from `md` and dot indicators everywhere. Each slide gets the full width of the container.
 *
 * <p>
 * Announced as a carousel (`aria-roledescription`) with each slide a labelled group ("2 of 3:
 * Daily money flow"), so a screen reader knows there is more than the one chart it is on.
 * </p>
 */
export function Carousel({ slides, label = "Charts", className }: { slides: CarouselSlide[]; label?: string; className?: string }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);

  // Keep `active` in sync with the actual scroll position (touch + arrows).
  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const onScroll = () => {
      const w = sc.clientWidth;
      const idx = Math.round(sc.scrollLeft / Math.max(1, w));
      setActive(Math.max(0, Math.min(slides.length - 1, idx)));
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => sc.removeEventListener("scroll", onScroll);
  }, [slides.length]);

  const goTo = (i: number) => {
    const sc = scrollerRef.current;
    if (!sc) return;
    sc.scrollTo({ left: i * sc.clientWidth, behavior: "smooth" });
  };

  if (slides.length === 0) return null;

  return (
    <div role="group" aria-roledescription="carousel" aria-label={label} className={cn("relative", className)}>
      {/*
        The scroller is inset on desktop by exactly the width of the arrows beside it. The arrows
        once hung 12px outside the container with 24px of them INSIDE it, drawn over the chart's
        y-axis labels; giving them their own 40px gutter is the fix.
      */}
      <div
        ref={scrollerRef}
        className="no-scrollbar flex snap-x snap-mandatory overflow-x-auto md:mx-10"
        style={{ scrollbarWidth: "none" }}
      >
        {slides.map((s, i) => (
          <div
            key={s.key}
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${slides.length}${s.title ? `: ${s.title}` : ""}`}
            className="w-full shrink-0 snap-center px-1"
          >
            {s.title && <p className={cn(typography({ variant: "overline" }), "mb-3")}>{s.title}</p>}
            {s.node}
          </div>
        ))}
      </div>

      {slides.length > 1 && (
        <>
          <ArrowButton label="Previous" side="left" atEnd={active === 0} onPress={() => goTo(Math.max(0, active - 1))}>
            <CaretLeft weight="bold" />
          </ArrowButton>
          <ArrowButton label="Next" side="right" atEnd={active === slides.length - 1} onPress={() => goTo(Math.min(slides.length - 1, active + 1))}>
            <CaretRight weight="bold" />
          </ArrowButton>

          {/*
            Dots. The pill a reader sees is 6px tall and the button around it is 44×44 — the house
            touch floor (review round 2, A11Y F3-19: 24×24 met SC 2.5.8 but not the 44 the rest of
            the admin keeps); each inactive dot was once a 6×6 target, and at 375px the dots are
            the primary way between slides. `no-lift`: a dot that jumps under the finger reads as
            a mis-tap; the pill's own width change is the feedback.
          */}
          <div className="mt-2 flex justify-center">
            {slides.map((s, i) => (
              <button
                key={s.key}
                type="button"
                onClick={() => goTo(i)}
                aria-label={`Go to slide ${i + 1}`}
                aria-current={i === active ? "true" : undefined}
                data-testid="carousel-dot"
                className="no-lift group flex size-touch items-center justify-center"
              >
                <span
                  aria-hidden
                  className={cn(
                    "block h-1.5 rounded-full transition-all duration-base ease-standard motion-reduce:transition-none",
                    i === active ? "w-4 bg-accent-strong" : "w-1.5 bg-border group-hover:bg-text-muted",
                  )}
                />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

type ArrowProps = { label: string; side: "left" | "right"; atEnd: boolean; onPress: () => void; children: ReactNode };

/**
 * A desktop arrow: 36px to the eye and 44px to the finger (the `icon-sm` hit area), inside the
 * scroller's own 40px gutter, named by its label and its tooltip — the icon-button anatomy.
 *
 * At its end it is `aria-disabled` and ignores the press — never `disabled` (R15 X15-5): a
 * disabled button blurs, so the press that brought in the last slide dropped focus to `<body>`
 * and the next Tab started again at the skip link. The week strip's arrows do the same.
 */
function ArrowButton(props: ArrowProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { label, side, atEnd, onPress, children } = props;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          size="icon-sm"
          variant="outline"
          onClick={() => { if (!atEnd) onPress(); }}
          aria-disabled={atEnd || undefined}
          icon={children}
          // Centred with `inset-y-0 my-auto`, never a translate: the lift rule and the disabled
          // state both set `transform`, and either would knock a translated arrow off centre.
          className={cn("absolute inset-y-0 my-auto hidden rounded-full md:inline-flex aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-bg-surface", side === "left" ? "left-0" : "right-0")}
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
