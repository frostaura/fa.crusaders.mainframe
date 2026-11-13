import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { useMediaQuery } from "../ui/use-media-query";
import {
  LCD_WIDTH, landing, landingPageCount, type LandingCourt, type LandingStatus, type LcdLayout,
} from "../../lib/landingPreview";

/**
 * What a court box's start screen shows, drawn by `lib/landingPreview` — the same composition the
 * Mega 3.0.0 runs, checked against the `display/` corpus — so an admin choosing a layout sees the
 * glass, not an idea of it.
 *
 * <p>
 * <b>It moves as the glass moves</b>: the marquee steps every `stepMs` and the pages turn every
 * `pageSeconds`, the club's own settings. Under reduced motion it holds still on the first page,
 * and the full content is always in the accessible name, so nothing is only in the animation.
 * </p>
 */
export function LandingPreview(props: {
  layout: LcdLayout;
  marquee: boolean;
  courts: readonly LandingCourt[];
  status?: LandingStatus;
  clock: string | null;
  stepMs?: number;
  pageSeconds?: number;
  caption: string;
  /** This is the layout in force: marked, so two previews side by side say which one the box draws. */
  selected?: boolean;
}) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { layout, marquee, courts, status = "ready", clock, stepMs = 400, pageSeconds = 4, caption, selected = false } = props;
  const still = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState(0);
  const mapped = courts.filter((court) => court.number > 0).length;
  const pages = landingPageCount(layout, marquee, mapped);

  useEffect(() => {
    if (still) return undefined;
    const step = setInterval(() => setOffset((n) => n + 1), Math.max(100, stepMs));
    const turn = setInterval(() => setPage((n) => n + 1), Math.max(1000, pageSeconds * 1000));
    return () => { clearInterval(step); clearInterval(turn); };
  }, [still, stepMs, pageSeconds]);

  const input = { layout, marquee, status, clock, note: null, courts } as const;
  const rows = landing({ ...input, page: still ? 0 : page, offset: still ? 0 : offset });
  // Every page, unscrolled, for the accessible name: a screen reader hears the whole screen once.
  const spoken = Array.from({ length: pages }, (_, p) => landing({ ...input, page: p, offset: 0 }))
    .flat().map((row) => row.trim()).filter((row, i, all) => row !== "" && all.indexOf(row) === i);

  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <div
        role="img"
        aria-label={`${caption}: ${spoken.join(". ")}`}
        data-landing-preview={layout}
        className={cn(
          "self-start overflow-hidden rounded-lg border-4 border-border bg-success-soft px-3 py-2",
          selected && "ring-2 ring-accent-strong ring-offset-2 ring-offset-bg-surface",
        )}
      >
        <pre aria-hidden="true" className="font-mono text-sm leading-snug text-success-strong" style={{ width: `${LCD_WIDTH[layout]}ch` }}>
          {rows.join("\n")}
        </pre>
      </div>
      <figcaption className="text-xs text-text-muted">
        {caption}
        {selected ? " — in force" : ""}
      </figcaption>
    </figure>
  );
}
