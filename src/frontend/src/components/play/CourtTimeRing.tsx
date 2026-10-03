import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { CheckCircle, Target } from "@/components/ui/icons";
import type { Ring } from "@/lib/playApi";
import { RING_COPY } from "@/lib/playCopy";
import { cn } from "@/lib/utils";
import { keepUnits } from "@/components/members/keepUnits";

/**
 * R8 — the ring never pushes a 320 phone sideways at 200 % text (7rem + the gap + the edit button
 * outgrew the card: 1px), and its centre figure keeps each number with its unit ("6 h" / "45 min").
 * It steps down by My game's own box in rem (`@container/game`), so only LARGE text shrinks it.
 */
const RING_BOX = "relative size-20 shrink-0 @[18rem]/game:size-28";

/**
 * The monthly court-time ring (§9.1.1, §5.5): minutes on court this club month against the
 * member's own goal. <b>No goal → no ring</b> — a quiet row offering to set one, because an
 * empty ring nobody asked for reads as a chore.
 *
 * <p>
 * The fill is a `stroke-dashoffset` transition over the `count` duration and stands still under
 * reduced motion; the ring itself is decorative — its `aria-label` says both figures in words.
 * Minutes come from attendance, never from results (§5.1).
 * </p>
 */
const R = 44;
const CIRCUMFERENCE = 2 * Math.PI * R;

export function CourtTimeRing({ ring, onEditGoal }: { ring: Ring | null; onEditGoal: () => void }) {
  if (!ring) {
    return (
      // F4-14 — the hint keeps a readable measure (12rem) before the button gives way: with
      // `flex-1 min-w-0` alone it was the TEXT that shrank, squeezed into 5–6 lines beside the
      // button at 375/390. Now the button drops under the text there, full width. F4-7: its label
      // wraps at 200 % text rather than overflowing (design-system rule for labels that must wrap).
      <div data-ring="none" className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border p-4">
        <Target size="1.25rem" aria-hidden="true" className="shrink-0 text-text-muted" />
        <p className="min-w-0 grow basis-48 text-sm text-text-secondary">{RING_COPY.setGoalHint}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={onEditGoal}
          className="h-auto min-h-touch w-full whitespace-normal py-2 sm:w-auto"
        >
          {RING_COPY.setGoal}
        </Button>
      </div>
    );
  }
  const fraction = ring.goal_minutes > 0 ? Math.min(1, ring.attended_minutes / ring.goal_minutes) : 0;
  // F4.11 — ring, words and the edit button used to share one row, which left the words a
  // narrow column on a phone (a 112px ring and a 44px button beside them). A grid: on a phone the
  // ring and the button share the first row and the words take the whole second; from `sm` all
  // three sit on one row.
  return (
    <div
      data-ring={ring.reached ? "reached" : "open"}
      className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-4 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
    >
      <div role="img" aria-label={RING_COPY.aria(ring.attended_minutes, ring.goal_minutes)} className={RING_BOX}>
        <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden="true">
          <circle cx="50" cy="50" r={R} fill="none" strokeWidth="8" className="stroke-current text-bg-muted" />
          <circle
            data-ring-fill=""
            cx="50" cy="50" r={R} fill="none" strokeWidth="8" strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
            className={cn(
              "stroke-current transition-[stroke-dashoffset] duration-count ease-out motion-reduce:transition-none",
              ring.reached ? "text-success-strong" : "text-accent-strong",
            )}
          />
        </svg>
        <span aria-hidden="true" className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-sm font-semibold tabular-nums leading-tight text-text-primary">{keepUnits(RING_COPY.centre(ring.attended_minutes))}</span>
        </span>
      </div>
      <div data-ring-words="" className="col-span-2 row-start-2 flex min-w-0 flex-col gap-1 sm:col-span-1 sm:col-start-2 sm:row-start-1">
        <p className="text-sm font-semibold text-text-primary">{RING_COPY.title}</p>
        <p className="text-sm text-text-secondary">{RING_COPY.caption(ring.goal_minutes)}</p>
        <p className="text-xs text-text-secondary">{RING_COPY.sessions(ring.sessions)}</p>
        {ring.reached ? (
          <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-success-strong">
            <CheckCircle size="1rem" weight="bold" aria-hidden="true" />
            {RING_COPY.reached}
          </p>
        ) : null}
      </div>
      <IconButton label={RING_COPY.editGoal} onClick={onEditGoal} className="col-start-2 row-start-1 self-start justify-self-end sm:col-start-3">
        <Target aria-hidden="true" />
      </IconButton>
    </div>
  );
}
