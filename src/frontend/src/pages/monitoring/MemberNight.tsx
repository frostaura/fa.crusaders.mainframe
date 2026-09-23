import { useCallback, useEffect, useState } from "react";
import { Alert } from "../../components/Alert";
import { Card, CardContent } from "../../components/ui/card";
import { DatePicker } from "../../components/ui/date-picker";
import { MemberCombobox } from "../../components/ui/member-combobox";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { PageHeader, PageShell } from "../../components/ui/page-shell";
import { StateBlock } from "../../components/ui/state-block";
import { CardListSkeleton, DownloadCsvLink } from "../../components/monitoring/parts";
import { clubClock, clubDate } from "../../lib/clubClock";
import { endpoints, type AdminMember } from "../../lib/api";

/** A member as this page holds one: the id it reads by, the name it shows. */
type PickableMember = { user_id: string; full_name: string; membership_number?: string | null };

const MEMBERS_FAILED = "Couldn't read the club's members. That is not the same as the club having none — try again.";
import { adminEndpoints, type TraceView } from "../../lib/adminApi";
import { buildTimeline, burstOutcomes, durationInWords, hasApproximateTimes } from "../../lib/nightTimeline";
import {
  APPROXIMATE_EXPLANATION, NIGHT_EMPTY_HINT, NIGHT_EXPORT_NOTE, NIGHT_NO_MEMBER_YET,
  NIGHT_PRIVACY_NOTICE, actorClause, gapLine, isOnBehalf, nightEmptyNotice, nightWindowHint,
  retentionCaveat,
} from "../../lib/nightCopy";

/**
 * A person's night — GOAL item 6. `/admin/monitoring/night`.
 *
 * <p>
 * <b>This surface exists because Dean asked for it and it overrides a standing contract.</b>
 * The doors contract says the club keeps no attendance record and the admin door log carries
 * no per-member filter anywhere; `GOAL.md` supersedes that for this page only, and says so
 * explicitly. An override taken quietly would be the worst outcome, so it is taken loudly:
 * admin-only, retention-bound, and every successful read writes a line in the undeletable
 * change record naming who looked and at whom. The notice on the page says so before anybody
 * presses anything.
 * </p>
 *
 * <p>
 * <b>The member is a path segment on the wire, and that is structural rather than stylistic.</b>
 * A query parameter would eventually be made optional by somebody, and an optional member
 * filter on a log IS the thing the doors contract exists to prevent. There is no list of
 * traces, no search, and no index: the only way in is a member an admin already named. You
 * cannot discover a person here; you can only ask about one you already have.
 * </p>
 *
 * <p>
 * <b>Actor versus subject is the spine.</b> Every card says who did it, and a card where
 * somebody acted ON this member is marked — that is the `{actor, subject}` invariant made
 * visible for the first time in this product.
 * </p>
 */

/** The three nights offered as buttons, newest first, ending with today. */
function recentNights(today: Date): Array<{ iso: string; label: string }> {
  return [0, 1, 2].map((back) => {
    const day = new Date(today);
    day.setDate(day.getDate() - back);
    const iso = day.toISOString().slice(0, 10);
    return { iso, label: back === 0 ? "Tonight" : back === 1 ? "Last night" : clubDate(day) };
  });
}

/**
 * The night itself: one list, three kinds of row.
 *
 * <p>
 * Its own component because the three arms are the whole of what this surface draws, and
 * because the page around it is a chooser — a member, a night, and the states a read can be
 * in. Keeping the two together made one function that both fetched and rendered a timeline.
 * </p>
 */
function NightTimeline({ rows, subjectName, timezone }: {
  rows: ReturnType<typeof buildTimeline>;
  subjectName: string;
  timezone: string | undefined;
}) {
  return (
    <ol className="relative space-y-3 border-l-2 border-border pl-4">
      {rows.map((row, index) => (
        <li key={`${row.kind}-${index}`}>
          {row.kind === "gap" ? (
            /* Drawn, not closed up. A night with an hour missing from the middle and
               no sign of it reads as a continuous evening, which is a claim. */
            <p className="border-l-2 border-dashed border-border py-2 pl-3 text-sm text-text-muted">
              {gapLine(durationInWords(row.minutes))}
            </p>
          ) : row.kind === "burst" ? (
            <details className="rounded-lg bg-bg-muted p-3">
              {/* A real `<details>`: the disclosure semantics are free, the summary is
                  the accessible name, and it works with no JavaScript at all. */}
              <summary className="min-h-11 cursor-pointer text-sm font-medium">
                {`${clubClock(row.at, timezone)} · ${row.events.length} in ${
                  durationInWords(Math.max(1, Math.round(
                    (Date.parse(row.events.at(-1)!.at) - Date.parse(row.at)) / 60_000,
                  )))
                }`}
              </summary>
              <p className="mt-1 text-sm text-text-secondary">{burstOutcomes(row.events).join(", ")}</p>
            </details>
          ) : (
            <TraceCard event={row.event} subjectName={subjectName} timezone={timezone} />
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * Who, and which night — the two questions this surface cannot do anything without.
 *
 * <p>
 * Its own component because the page's remaining branching was almost entirely here: three
 * separate `!member` guards disabling a control and saying why, plus the picker's own
 * loading and failed states. None of it is about a timeline.
 * </p>
 */
function NightChooser({
  pickable, member, onMember, membersLoading, membersFailed, day, onDay, rangeHint,
}: {
  pickable: PickableMember[];
  member: PickableMember | null;
  onMember: (next: PickableMember | null) => void;
  membersLoading: boolean;
  membersFailed: boolean;
  day: string;
  onDay: (next: string) => void;
  rangeHint: string;
}) {
  return (
    <Card>
      <CardContent className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <MemberCombobox
            label="Which member?"
            placeholder="Search the club's members"
            members={pickable.map((m) => ({ id: m.user_id, name: m.full_name, subtitle: m.membership_number ?? null }))}
            value={member?.user_id ?? null}
            onChange={(id) => onMember(pickable.find((m) => m.user_id === id) ?? null)}
            loading={membersLoading}
            error={membersFailed ? MEMBERS_FAILED : null}
          />
          <p className="text-sm text-text-muted">
            There is nothing to trace for a visitor booked in under a written-in name, so only members appear here.
          </p>
        </div>

        <div role="group" aria-labelledby="night-day-label" className="flex flex-col gap-1.5">
          <span id="night-day-label" className="text-sm font-medium text-text-primary">Which night?</span>
          {/* Disabled until the first half is answered, and the disabled half SAYS WHY —
              a greyed-out control with no explanation is a dead end somebody stares at. */}
          {!member && <p className="text-sm text-text-secondary">{NIGHT_NO_MEMBER_YET}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <DatePicker label="Which night?" value={day} onChange={onDay} disabled={!member} />
            <ToggleGroup
              type="single"
              aria-label="Recent nights"
              value={day}
              disabled={!member}
              onValueChange={(next) => { if (next) onDay(next); }}
              className="rounded-lg bg-bg-muted p-1"
            >
              {recentNights(new Date()).map((night) => (
                <ToggleGroupItem key={night.iso} value={night.iso}>{night.label}</ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <p className="text-sm text-text-muted">{rangeHint}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The club's members, as the picker needs them, with its failure kept separate.
 *
 * A failed read must never reach the picker as an empty list — "the club has no members" is a
 * different sentence from "we could not ask", and rendering the first from the second is the
 * three-state trap this release is written against.
 */
function useClubMembers() {
  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [membersFailed, setMembersFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    endpoints.adminMembers()
      .then((rows) => { if (!cancelled) setMembers(rows); })
      .catch(() => { if (!cancelled) { setMembers([]); setMembersFailed(true); } });
    return () => { cancelled = true; };
  }, []);

  const pickable: PickableMember[] = (members ?? []).map((m) => ({
    user_id: m.user_id,
    full_name: m.full_name,
    membership_number: m.membership_number ?? null,
  }));
  return { pickable, membersLoading: members === null, membersFailed };
}

/**
 * One member's night, re-read whenever either half of the question changes.
 *
 * <p>
 * The previous night is CLEARED on a failure and on an unset member, deliberately and unlike
 * the control board: a timeline for the wrong person or the wrong night is not stale truth,
 * it is a different fact. On this surface of all surfaces, a timeline that outlives its
 * subject for even one paint is the wrong person's night.
 * </p>
 */
function useMemberNight(member: PickableMember | null, day: string) {
  const [view, setView] = useState<TraceView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const read = useCallback(async (userId: string, when: string) => {
    setLoading(true);
    try {
      setView(await adminEndpoints.memberTrace(userId, { day: when }));
      setError(null);
    } catch (err) {
      setView(null);
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Clearing the view when the member is unset IS the synchronisation — see above. The read
  // itself is async and every setState inside it runs in a promise callback.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    if (!member) { setView(null); setError(null); return; }
    void read(member.user_id, day);
  }, [member, day, read]);

  return { view, loading, error, read };
}

/**
 * Everything the page draws that is derived rather than fetched.
 *
 * <p>
 * Out of the component body because it is a run of optional chains over a read that may not
 * have happened yet — and a page component whose branching is all `?.` and `??` is one that
 * reads as complicated while doing nothing. Each fallback is a decision, though, and they are
 * the reason this is a function and not a spread: `subjectName` falls back from the name the
 * server returned, to the name the picker holds, to a phrase that names nobody, so a card
 * never says "undefined scanned".
 * </p>
 */
function nightView(view: TraceView | null, member: PickableMember | null) {
  // One guard instead of an optional chain per field: every line below reads a night that is
  // known to exist, and the absent case is answered once, here, where it is obvious.
  const read = view ?? EMPTY_NIGHT;
  const timezone = read.timezone;
  const events = read.events ?? [];
  return {
    timezone,
    events,
    rows: buildTimeline(events),
    subjectName: read.member?.name ?? member?.full_name ?? "this member",
    caveat: retentionCaveat(read.retention, timezone),
    retentionKey: read.club_day ?? "",
    rangeHint: nightWindowHint(read.range, timezone),
  };
}

/** What a night looks like before one has been read. Fields the wire may omit stay absent. */
const EMPTY_NIGHT = {} as Partial<TraceView>;

export function MemberNightPage() {
  const { pickable, membersLoading, membersFailed } = useClubMembers();
  const [member, setMember] = useState<PickableMember | null>(null);
  const [day, setDay] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const { view, loading, error, read } = useMemberNight(member, day);

  const { timezone, events, rows, subjectName, caveat, retentionKey, rangeHint } = nightView(view, member);

  return (
    // R17: this is a view of a MEMBER, not of the hardware, so Monitoring no longer links here.
    // The route still answers until P5 moves it onto the member's own page.
    <PageShell width="content">
      <PageHeader
        title="A person’s night"
        description="One member's evening at the club, in the order it happened — to settle a question, never to browse."
      />

      {/* Standing, and said once. It is a fact about the screen somebody has arrived at, not
          an event — and this block re-renders on every read, so `polite` would announce the
          whole paragraph again each time a night is chosen. */}
      <Alert tone="warning" live="standing" announceKey="night-privacy">
        {NIGHT_PRIVACY_NOTICE}
      </Alert>

      <NightChooser
        pickable={pickable}
        member={member}
        onMember={setMember}
        membersLoading={membersLoading}
        membersFailed={membersFailed}
        day={day}
        onDay={setDay}
        rangeHint={rangeHint}
      />

      {caveat && <Alert tone="info" live="standing" announceKey={`night-retention:${retentionKey}`}>{caveat}</Alert>}
      {hasApproximateTimes(events) && <p className="text-sm text-text-muted">{APPROXIMATE_EXPLANATION}</p>}

      {member && (
        <NightResult
          member={member}
          day={day}
          loading={loading}
          error={error}
          events={events}
          rows={rows}
          subjectName={subjectName}
          timezone={timezone}
          onRetry={() => read(member.user_id, day)}
        />
      )}
    </PageShell>
  );
}

/**
 * What the read produced — its three states, the timeline, and the export beside it.
 *
 * Its own component because the page above is now a question (who, and which night) and this
 * is the answer. It also takes the whole of the page's remaining branching with it: the empty
 * condition is three terms, and the export needs the member it was read for.
 */
function NightResult({
  member, day, loading, error, events, rows, subjectName, timezone, onRetry,
}: {
  member: PickableMember;
  day: string;
  loading: boolean;
  error: unknown;
  events: Parameters<typeof burstOutcomes>[0];
  rows: ReturnType<typeof buildTimeline>;
  subjectName: string;
  timezone: string | undefined;
  onRetry: () => void | Promise<unknown>;
}) {
  return (
    <StateBlock
      loading={loading}
      error={error}
      action="that night"
      // The one sentence most designs leave out. The server writes its audit row on a
      // 200, so a failed read that still claimed "opening this is recorded" would make
      // the notice above a lie about the only thing this surface promises.
      failedCaveat="Nothing was recorded about this look-up."
      onRetry={() => void onRetry()}
      empty={!loading && !error && events.length === 0}
      emptyTitle={nightEmptyNotice(subjectName, clubDate(day, timezone))}
      emptyHint={NIGHT_EMPTY_HINT}
      skeleton={<CardListSkeleton rows={3} />}
    >
      <div className="space-y-3">
        <NightTimeline rows={rows} subjectName={subjectName} timezone={timezone} />

        <div className="flex flex-wrap items-center gap-3">
          <DownloadCsvLink href={adminEndpoints.memberTraceCsvUrl(member.user_id, { day })} />
          <p className="min-w-0 flex-1 text-xs text-text-muted">{NIGHT_EXPORT_NOTE}</p>
        </div>
      </div>
    </StateBlock>
  );
}

/**
 * One event on the rail.
 *
 * The left rule is `info` where somebody acted ON this member, and the clause under the
 * headline names them. That is the `{actor, subject}` invariant this product has always had
 * in its audit table and has never shown anybody.
 */
function TraceCard({ event, subjectName, timezone }: {
  event: Parameters<typeof burstOutcomes>[0][number];
  subjectName: string;
  timezone: string | undefined;
}) {
  const clause = actorClause(event.actor, subjectName);
  const onBehalf = isOnBehalf(event.actor);
  return (
    <div className={onBehalf ? "border-l-4 border-info-strong pl-3" : "pl-3"}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-2">
        <time
          dateTime={event.at}
          className="shrink-0 font-mono text-sm tabular-nums text-text-muted"
        >
          {/* The ≈ is part of the time, not a footnote beside it: a reader scanning a column
              of times has to be able to see which ones are estimates without reading prose. */}
          {`${event.approximate ? "≈" : ""}${clubClock(event.at, timezone)}`}
        </time>
        <p className="min-w-0 break-words font-medium text-text-primary">
          {/* The server's sentence, rendered. Never one composed here from `kind` — that is
              the dictionary-drift defect this whole surface is written around. */}
          {event.headline ?? (event.kind ?? "").replace(/_/g, " ")}
        </p>
        {clause && (
          <span className={onBehalf ? "shrink-0 text-sm text-info-strong" : "shrink-0 text-sm text-text-muted"}>
            {clause}
          </span>
        )}
      </div>
      {typeof event.amount_credits === "number" && (
        <p className="text-sm text-text-secondary">
          {`${event.amount_credits < 0 ? "" : "+"}${event.amount_credits.toFixed(2)} credits`}
          {typeof event.balance_after_credits === "number"
            ? ` · balance ${event.balance_after_credits.toFixed(2)}`
            : ""}
        </p>
      )}
      {event.court?.name && <p className="text-sm text-text-muted">{event.court.name}</p>}
    </div>
  );
}
