import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Alert } from "@/components/Alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { WarningCircle } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { OfflineNothingKeptRetry } from "@/components/bookings/OfflineNothingKeptRetry";
import { OFFLINE_COPY } from "@/lib/offline/offlineCopy";
import { StateBlock } from "@/components/ui/state-block";
import { useSplitLayout } from "@/components/ui/use-split-layout";
import { Switch } from "@/components/ui/switch";
import { playEndpoints, type MyPlay } from "@/lib/playApi";
import {
  BADGES_COPY, CELEBRATIONS_SWITCH, PLAY_SETTINGS_UNSURE, GOAL_SHEET, MY_GAME, PLAY_REFUSAL, playRefusal, STATS_COPY, STREAK_COPY,
} from "@/lib/playCopy";
import { useToast } from "@/components/Toast";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { myPlayWrite } from "./resultReadBack";
import { BadgeGrid } from "./BadgeGrid";
import { CourtTimeRing } from "./CourtTimeRing";
import { FormAndPeople } from "./FormAndPeople";
import { GoalSheet } from "./GoalSheet";
import { clubYear } from "./playDates";
import { STATS_FRAME, STATS_GRID, StatsGrid, statSpan } from "./StatsGrid";
import { cn } from "@/lib/utils";
import { StreakCard } from "./StreakCard";
import { useMyGame, type MyGameRead } from "./useMyGame";

/**
 * "My game" (§9.1) — the FIRST section on Profile, because a member opens Profile to see this
 * far more often than to change a password. <b>Only you can see this.</b>
 *
 * <p>
 * In order: the court-time ring, the weekly streak with its injury pause, the figures, form and
 * people, the badges, and the celebrations switch at the foot. One read (`GET /me/play`), three
 * states: a skeleton while it reads, a failure with its retry — never zeros, which would tell a
 * regular they have never played — and the section.
 * </p>
 *
 * <p>
 * `/profile#my-game` (the badge notice's link) lands here once the section has content: the
 * browser's own jump happens before the read answers, when there is nothing yet to jump to.
 * </p>
 */
export function MyGameSection() {
  const read = useMyGame();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useJumpHere(ref, read.data !== null);
  return (
    <Card ref={ref} id={MY_GAME.anchor} role="region" aria-labelledby={titleId} data-my-game="">
      <CardHeader>
        <CardTitle asChild><h2 id={titleId}>{MY_GAME.title}</h2></CardTitle>
        <CardDescription>{MY_GAME.description}</CardDescription>
      </CardHeader>
      <CardContent className="@container/game flex flex-col gap-6">
        {/* R7 X7-3, R8 — offline with nothing kept on this phone: said as offline, never "couldn't be reached". Offline is the read's own (the club unreachable, a NetworkError), never navigator.onLine, which Wi-Fi without internet leaves true. */}
        {read.data === null && read.error != null && read.offline ? <OfflineNothingKeptRetry line={OFFLINE_COPY.nothingKept.myGame} onRetry={read.reload} /> : (
        <StateBlock
          loading={!read.data && read.loading}
          error={read.data ? null : read.error}
          action={MY_GAME.readAction}
          codes={PLAY_REFUSAL}
          onRetry={read.reload}
          skeleton={<MyGameSkeleton />}
        >
          {read.data ? <MyGameBody game={read.data} read={read} /> : null}
        </StateBlock>
        )}
      </CardContent>
    </Card>
  );
}

function useJumpHere(ref: React.RefObject<HTMLDivElement | null>, ready: boolean) {
  const { hash } = useLocation();
  const jumped = useRef(false);
  useEffect(() => {
    if (!ready || jumped.current || hash !== `#${MY_GAME.anchor}`) return;
    jumped.current = true;
    ref.current?.scrollIntoView?.({ block: "start" });
  }, [ready, hash, ref]);
}

function MyGameSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <div className="flex items-center gap-4">
        <Skeleton className="size-28 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-40 max-w-full" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
      <Skeleton className="h-6" />
      <div className={STATS_FRAME}>
        <div className={STATS_GRID}>
          {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className={cn("h-16 rounded-xl", statSpan(i, 5))} />)}
        </div>
      </div>
    </div>
  );
}

/** One part of the section, headed — an `h3` under the card's `h2`. */
/**
 * R4 form factor (SPEC 3.7): from a 56rem card My game is two columns, by the CARD's width —
 * the ring, the streak, the people you play with and the celebrations switch on the left; the
 * stats and the badges on the right.
 *
 * <p>
 * <b>Two independent columns, not shared grid rows</b> (R6 L6-18). The parts used to be placed
 * in grid areas ('ring stats' / 'streak stats' / 'people badges' / 'cel badges'), so each side
 * was stretched to the other's row heights: at 1920 a 160px blank band sat under the stats and
 * another above the celebrations. Each column now stacks its own parts. The DOM follows the
 * columns (measured by `useSplitLayout`, the container query's own measure), so Tab order is
 * still reading order; on a phone it is the phone's order — ring, streak, stats, people, badges.
 * </p>
 */
const BODY = "flex flex-col gap-6";
const BODY_SPLIT = "grid grid-cols-2 items-start gap-x-10 gap-y-8";
const COLUMN = "flex min-w-0 flex-col gap-8";

function Part({ title, children, part }: { title?: string; children: ReactNode; part: string }) {
  return (
    <div data-my-game-part={part} className="flex min-w-0 flex-col gap-3 border-t border-border pt-5 first:border-0 first:pt-0 @[56rem]/game:border-0 @[56rem]/game:pt-0">
      {title ? <h3 className="text-base font-semibold text-text-primary">{title}</h3> : null}
      {children}
    </div>
  );
}

function MyGameBody({ game, read }: { game: MyPlay; read: MyGameRead }) {
  const [goalOpen, setGoalOpen] = useState(false);
  const toast = useToast();
  const year = clubYear(game.as_of, game.timezone);
  const { attach, split } = useSplitLayout("56rem");
  const ring = <Part part="ring"><CourtTimeRing ring={game.ring} onEditGoal={() => setGoalOpen(true)} /></Part>;
  const streak = (
    <Part part="streak" title={STREAK_COPY.title}>
      <StreakCard
        streak={game.streak}
        pause={game.pause}
        year={year}
        onPause={(pause) => { read.patch((g) => ({ ...g, pause })); read.reload(); }}
      />
    </Part>
  );
  const stats = <Part part="stats" title={STATS_COPY.title}><StatsGrid stats={game.stats} /></Part>;
  const people = <Part part="people"><FormAndPeople form={game.form} partners={game.partners} opponents={game.opponents} /></Part>;
  const badges = <Part part="badges" title={BADGES_COPY.title}><BadgeGrid badges={game.badges} timezone={game.timezone} /></Part>;
  const celebrations = <Part part="celebrations"><CelebrationsSwitch game={game} read={read} /></Part>;
  return (
    <div ref={attach} data-my-game-body="" className={split ? BODY_SPLIT : BODY}>
      {read.error ? <div className={split ? "col-span-2" : undefined}><Alert tone="warning" live="polite">{MY_GAME.refreshFailed}</Alert></div> : null}
      {split ? (
        <>
          <div className={COLUMN}>{ring}{streak}{people}{celebrations}</div>
          <div className={COLUMN}>{stats}{badges}</div>
        </>
      ) : (
        <>{ring}{streak}{stats}{people}{badges}{celebrations}</>
      )}
      <GoalSheet
        open={goalOpen}
        onOpenChange={setGoalOpen}
        goalMinutes={game.settings.monthly_goal_minutes}
        onSaved={(settings, removed) => {
          setGoalOpen(false);
          toast.push({ tone: "success", text: removed ? GOAL_SHEET.removed : GOAL_SHEET.saved });
          read.patch((g) => ({ ...g, settings, ring: settings.monthly_goal_minutes === null ? null : g.ring }));
          read.reload();
        }}
      />
    </div>
  );
}

function CelebrationsSwitch({ game, read }: { game: MyPlay; read: MyGameRead }) {
  const on = game.settings.celebrations_enabled;
  // Lost-reply audit (R3): read back off My game, so a switch that did save is not flipped back.
  const flip = useAsyncAction((next: boolean) => myPlayWrite(
    () => playEndpoints.saveSettings({ celebrationsEnabled: next }),
    (p) => (p.settings.celebrations_enabled === next ? p.settings : null),
  ), {
    optimistic: {
      apply: (next) => read.patch((g) => ({ ...g, settings: { ...g.settings, celebrations_enabled: next } })),
      rollback: (next) => read.patch((g) => ({ ...g, settings: { ...g.settings, celebrations_enabled: !next } })),
    },
    success: ({ value }) => read.patch((g) => ({ ...g, settings: value })),
  });
  return (
    <div className="flex flex-col gap-2" data-celebrations="">
      {/* R4 X4-6 — the words and the switch share a row while they fit; at 200 % text on a phone
          the switch wraps under the words (a real basis), where "Celebratio/ns" broke beside it. */}
      <Field controlId="celebrations-switch" className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 grow basis-40 flex-col gap-0.5 break-words">
          <FieldLabel>{CELEBRATIONS_SWITCH.label}</FieldLabel>
          <FieldDescription className="break-words">{CELEBRATIONS_SWITCH.hint}</FieldDescription>
        </div>
        <div className="flex min-h-touch shrink-0 items-center">
          <Switch
            checked={on}
            aria-busy={flip.pending || undefined}
            onCheckedChange={(next) => { if (!flip.pending) void flip.run(next); }}
          />
        </div>
      </Field>
      {flip.error ? (
        <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-danger-strong">
          <WarningCircle size={16} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{playRefusal(flip.error, CELEBRATIONS_SWITCH.action, PLAY_SETTINGS_UNSURE.celebrations)}</span>
        </p>
      ) : null}
    </div>
  );
}
