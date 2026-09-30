import { useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Medal, Target } from "@/components/ui/icons";
import { CELEBRATION_COPY, MY_GAME, playWhen } from "@/lib/playCopy";
import { typography } from "@/lib/typography";
import { cn } from "@/lib/utils";
import { BadgeMark } from "./BadgeGrid";
import { isQuietPath, momentOf, type Moment } from "./celebrationRules";
import { useCelebrations } from "./useCelebrations";

/**
 * The one-shot moment (§9.3), mounted once in the app shell: a badge earned, a monthly goal
 * reached. One at a time, oldest first; more than three waiting collapse into one ("4 new
 * badges") that leads to My game.
 *
 * <p>
 * <b>Never over the pass.</b> Not on `/my-code` (the card at the court must never be covered),
 * not on an invite link or an auth page, and never while any other sheet, dialog or popover is
 * open — it waits for the next route or for the other surface to close. Acknowledged on either
 * button or the close ×, never on display alone.
 * </p>
 *
 * <p>
 * <b>Motion is CSS on the existing tokens</b> — the scrim's `overlay-in`, the medallion's
 * `pop-in`, one `breathe` glow, the ring's `stroke-dashoffset` over `count` — and every one of
 * them stands still under `prefers-reduced-motion`. The dialog's title is its accessible name,
 * so the moment is announced either way.
 * </p>
 */


/* ─────────────────────────────── is any other surface open? ─────────────────────────────── */

const SURFACE = '[role="dialog"]:not([data-celebration]), [role="alertdialog"]';

function subscribeSurfaces(listener: () => void): () => void {
  if (typeof MutationObserver === "undefined") return () => undefined;
  const observer = new MutationObserver(listener);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}

function anotherSurfaceOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector(SURFACE) !== null;
}

/* ─────────────────────────────── the moment ─────────────────────────────── */

export function CelebrationOverlay() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { items, acknowledge } = useCelebrations();
  const blocked = useSyncExternalStore(subscribeSurfaces, anotherSurfaceOpen, () => false);
  const moment = momentOf(items);
  const quiet = isQuietPath(pathname);
  // Held back, not dropped: the same moment shows on the next route, or once the sheet closes.
  const showing = moment !== null && !quiet && !blocked;
  if (!moment || !showing) return null;
  const ids = moment.kind === "many" ? moment.ids : [moment.celebration.id];
  const dismiss = () => acknowledge(ids);
  const seeMyGame = () => {
    acknowledge(ids);
    navigate(`/profile#${MY_GAME.anchor}`);
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) dismiss(); }}>
      <DialogContent data-celebration="" data-celebration-kind={moment.kind === "many" ? "many" : moment.celebration.kind}>
        <Medallion moment={moment} />
        <MomentWords moment={moment} />
        <DialogFooter className="sm:justify-center">
          <Button variant="outline" onClick={seeMyGame}>{CELEBRATION_COPY.seeMyGame}</Button>
          <Button onClick={dismiss}>{CELEBRATION_COPY.keepPlaying}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MomentWords({ moment }: { moment: Moment }) {
  const { overline, name, body } = wordsFor(moment);
  const earned = moment.kind === "one" && moment.celebration.kind === "badge" ? CELEBRATION_COPY.earned(playWhen(moment.celebration.created_at)) : null;
  return (
    <DialogHeader className="items-center pl-4 pr-4 text-center sm:pl-6 sm:pr-6">
      <DialogTitle className="flex flex-col items-center gap-1">
        <span className={typography({ variant: "overline" })}>{overline}</span>
        {name ? <span className="sr-only">: </span> : null}
        {name ? <span className="text-xl font-semibold text-text-primary">{name}</span> : null}
      </DialogTitle>
      <DialogDescription>{body}</DialogDescription>
      {earned ? <p data-celebration-earned="" className="text-xs text-text-secondary">{earned}</p> : null}
    </DialogHeader>
  );
}

function wordsFor(moment: Moment): { overline: string; name: string | null; body: string } {
  if (moment.kind === "many") {
    return { overline: CELEBRATION_COPY.many(moment.ids.length), name: null, body: CELEBRATION_COPY.manyBody };
  }
  const c = moment.celebration;
  if (c.kind === "goal_reached") {
    return { overline: CELEBRATION_COPY.goalReached, name: null, body: CELEBRATION_COPY.goalBody(c.goal_minutes) };
  }
  return { overline: CELEBRATION_COPY.newBadge, name: c.badge?.name ?? null, body: c.badge?.description ?? "" };
}

const MOVES = "motion-reduce:animate-none";

function MomentMark({ moment }: { moment: Moment }) {
  if (moment.kind === "one" && moment.celebration.badge) return <BadgeMark badgeKey={moment.celebration.badge.key} size={40} earned />;
  if (moment.kind === "one" && moment.celebration.kind === "goal_reached") return <Target size={40} weight="fill" />;
  return <Medal size={40} weight="fill" />;
}

function Medallion({ moment }: { moment: Moment }) {
  const goal = moment.kind === "one" && moment.celebration.kind === "goal_reached";
  return (
    <div aria-hidden="true" className="flex justify-center pt-8">
      <span className="relative flex size-24 items-center justify-center">
        <span data-celebration-glow="" className={cn("absolute inset-0 rounded-full bg-accent-soft animate-chip-breathe", MOVES)} />
        {goal ? <GoalRing /> : null}
        <span
          data-celebration-medallion=""
          className={cn(
            "relative flex size-20 items-center justify-center rounded-full bg-primary text-primary-ink shadow-md animate-pop-in",
            MOVES,
          )}
        >
          <MomentMark moment={moment} />
        </span>
      </span>
    </div>
  );
}

/** The ring, full — a goal reached. The fill transitions over `count`, still under reduced motion. */
function GoalRing() {
  return (
    <svg viewBox="0 0 100 100" className="absolute inset-0 size-full -rotate-90">
      <circle
        cx="50" cy="50" r="47" fill="none" strokeWidth="6" strokeDasharray="295.3" strokeDashoffset="0"
        className="stroke-current text-success-strong transition-[stroke-dashoffset] duration-count ease-out motion-reduce:transition-none"
      />
    </svg>
  );
}
