import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Section } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { StateBlock } from "@/components/ui/state-block";
import { TextLink } from "@/components/ui/text-link";
import { playEndpoints, type AdminMemberPlay } from "@/lib/playApi";
import { adminMemberReads, joinEarly } from "@/lib/offline/adminEarlyReads";
import { useDataOwner } from "@/lib/offline/useCachedRead";
import { hoursAndMinutes, hoursAndMinutesSpoken, MEMBER_PLAY_CARD as COPY, PLAY_REFUSAL } from "@/lib/playCopy";

/**
 * The Play card on an admin's member Overview (§9.4, §14 Q3): five figures — sessions, this
 * month's court time, the current streak, the match record, open disputes (linking to Match
 * results). <b>Counts only</b>: no partners, no opponents, no badge list — those are the
 * member's alone (§10). A card on Overview rather than a seventh tab, because a summary is five
 * numbers and the tab row is already six long.
 */
type Held = { key: string; data: AdminMemberPlay | null; error: unknown };

function usePlaySummary(userId: string) {
  const [nonce, setNonce] = useState(0);
  const asked = `${userId}:${nonce}`;
  const [held, setHeld] = useState<Held>({ key: "", data: null, error: null });
  const { who } = useDataOwner();
  useEffect(() => {
    let live = true;
    // The first read joins the one the member page started beside its detail (P4-5).
    const read = asked.endsWith(":0") ? joinEarly(who, adminMemberReads.play(userId)) : playEndpoints.adminMemberPlay(userId);
    read.then(
      (data) => { if (live) setHeld({ key: asked, data, error: null }); },
      (error: unknown) => { if (live) setHeld({ key: asked, data: null, error }); },
    );
    return () => { live = false; };
  }, [userId, asked, who]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const fresh = held.key === asked;
  return { data: fresh ? held.data : null, error: fresh ? held.error : null, loading: !fresh, reload };
}

export function MemberPlayCard({ userId }: { userId: string }) {
  const read = usePlaySummary(userId);
  return (
    <Section title={COPY.title} description={COPY.description} data-member-play="">
      <StateBlock
        loading={read.loading}
        error={read.error}
        action={COPY.readAction}
        codes={PLAY_REFUSAL}
        onRetry={read.reload}
        skeleton={<div className="grid gap-3 sm:grid-cols-3">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>}
      >
        {read.data ? <Figures play={read.data} /> : null}
      </StateBlock>
    </Section>
  );
}

function Tile({ label, value, spoken, hint, children }: { label: string; value: string; spoken?: string; hint: string; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-bg-surface p-4">
      <dt className="text-sm font-medium text-text-secondary">{label}</dt>
      <dd className="font-display text-2xl font-bold tabular-nums text-text-primary">
        {/* R6 X6-2: a compact figure is seen; its words are heard. */}
        {spoken ? <><span aria-hidden="true">{value}</span><span className="sr-only">{spoken}</span></> : value}
      </dd>
      <dd className="text-xs text-text-muted">{hint}</dd>
      {children ? <dd>{children}</dd> : null}
    </div>
  );
}

function Figures({ play }: { play: AdminMemberPlay }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-3">
      <Tile label={COPY.sessions} value={String(play.sessions_attended)} hint={COPY.sessionsHint} />
      <Tile
        label={COPY.thisMonth}
        value={hoursAndMinutes(play.minutes_this_month)}
        spoken={hoursAndMinutesSpoken(play.minutes_this_month)}
        hint={COPY.thisMonthHint(hoursAndMinutesSpoken(play.minutes_all_time))}
      />
      <Tile label={COPY.streak} value={COPY.streakValue(play.current_streak_weeks)} hint={COPY.streakHint} />
      <Tile label={COPY.record} value={COPY.recordValue(play.matches_won, play.matches_lost)} hint={COPY.recordHint(play.matches_played)} />
      <Tile label={COPY.disputes} value={String(play.open_disputes)} hint={COPY.disputesHint}>
        {play.open_disputes > 0 ? <TextLink to="/admin/results" variant="standalone">{COPY.openDisputes}</TextLink> : null}
      </Tile>
    </dl>
  );
}
