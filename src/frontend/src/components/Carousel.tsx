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
      <div
        ref={scrollerRef}
        className="overflow-x-auto snap-x snap-mandatory no-scrollbar flex"
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
            className="hidden md:flex absolute left-0 top-1/2 -translate-y-1/2 -translate-x-3 w-9 h-9 rounded-full bg-bg-surface border border-border shadow-sm items-center justify-center text-text-secondary hover:text-text-primary disabled:opacity-30"
            disabled={active === 0}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            aria-label="Next"
            onClick={() => goTo(Math.min(slides.length - 1, active + 1))}
            className="hidden md:flex absolute right-0 top-1/2 -translate-y-1/2 translate-x-3 w-9 h-9 rounded-full bg-bg-surface border border-border shadow-sm items-center justify-center text-text-secondary hover:text-text-primary disabled:opacity-30"
            disabled={active === slides.length - 1}
          >
            <ChevronRight size={18} />
          </button>

          {/* Dots */}
          <div className="flex justify-center gap-1.5 mt-3">
            {slides.map((s, i) => (
              <button
                key={s.key}
                type="button"
                onClick={() => goTo(i)}
                aria-label={`Go to slide ${i + 1}`}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  i === active ? "w-6 bg-info-strong" : "w-1.5 bg-border hover:bg-text-muted",
                )}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
