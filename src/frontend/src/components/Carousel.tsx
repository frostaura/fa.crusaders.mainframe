import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

export type CarouselSlide = { key: string; title?: string; node: React.ReactNode };

/**
 * Mobile-first horizontal carousel — uses native scroll-snap so swipe gestures
 * are free, with arrow buttons + dot indicators for desktop. Each slide gets
 * the full width of the container.
 */
export function Carousel({ slides, className }: { slides: CarouselSlide[]; className?: string }) {
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
    <div className={cn("relative", className)}>
      {/*
        The scroller is inset on desktop by exactly the width of the arrows beside it.

        Measured in a browser: the Previous arrow occupied x 32-68 while the chart's leftmost
        y-axis label started at x 49.9 — a 36px opaque button sitting on top of the numbers. The
        arrows were positioned `left-0 -translate-x-3`, which hangs them 12px outside the
        container and leaves 24px of them INSIDE it, over whatever the slide draws there. Giving
        them their own gutter is the fix; nudging the chart's own margins only moves which part
        of the plot they cover.
      */}
      <div
        ref={scrollerRef}
        className="overflow-x-auto snap-x snap-mandatory no-scrollbar flex md:mx-10"
        style={{ scrollbarWidth: "none" }}
      >
        {slides.map((s) => (
          <div key={s.key} className="snap-center shrink-0 w-full px-1">
            {s.title && <p className="text-xs uppercase tracking-wide text-text-muted mb-2">{s.title}</p>}
            {s.node}
          </div>
        ))}
      </div>

      {slides.length > 1 && (
        <>
          {/* Desktop arrows */}
          <button
            type="button"
            aria-label="Previous"
            onClick={() => goTo(Math.max(0, active - 1))}
            className="hidden md:flex absolute left-0 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-bg-surface border border-control shadow-sm items-center justify-center text-text-secondary hover:text-text-primary disabled:opacity-30"
            disabled={active === 0}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            aria-label="Next"
            onClick={() => goTo(Math.min(slides.length - 1, active + 1))}
            className="hidden md:flex absolute right-0 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-bg-surface border border-control shadow-sm items-center justify-center text-text-secondary hover:text-text-primary disabled:opacity-30"
            disabled={active === slides.length - 1}
          >
            <ChevronRight size={18} />
          </button>

          {/*
            Dots.

            The pill a reader sees is 6px tall, and the button around it is 24×24 — the two are
            not the same thing. They were: each inactive dot was a 6 × 6 px hit target, 6px from
            its neighbour, which is a quarter of the 24 × 24 WCAG 2.2 SC 2.5.8 asks for and well
            under the design system's own touch guidance. At 375px these dots are the primary way
            to move between chart slides, so the control a thumb has to hit was the smallest thing
            on the screen. Keyboard users were already fine — the labels and the focus ring were
            correct — which is exactly why this was invisible to anything but a thumb.

            `no-lift` because a dot that jumps a pixel under the finger reads as a mis-tap; the
            pill's own width change is the feedback.
          */}
          <div className="flex justify-center mt-1">
            {slides.map((s, i) => (
              <button
                key={s.key}
                type="button"
                onClick={() => goTo(i)}
                aria-label={`Go to slide ${i + 1}`}
                aria-current={i === active ? "true" : undefined}
                data-testid="carousel-dot"
                className="no-lift group w-6 h-6 flex items-center justify-center"
              >
                <span
                  aria-hidden
                  className={cn(
                    "block h-1.5 rounded-full transition-all",
                    i === active ? "w-4 bg-info-strong" : "w-1.5 bg-border group-hover:bg-text-muted",
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
