import { useCallback, useEffect, useState } from "react";
import { Alert } from "../../components/Alert";
import { Button, Input, Label } from "../../components/Button";
import { Card } from "../../components/Card";
import { MemberPicker, type PickableMember } from "../../components/MemberPicker";
import { MonitoringNav } from "../../components/monitoring/MonitoringSection";
import { StateBlock } from "../../components/StateBlock";
import { clubClock, clubDate } from "../../lib/clubClock";
import { endpoints, type AdminMember } from "../../lib/api";
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

export function MemberNightPage() {
  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [membersFailed, setMembersFailed] = useState(false);
  const [member, setMember] = useState<PickableMember | null>(null);
  const [day, setDay] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [view, setView] = useState<TraceView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    endpoints.adminMembers()
      .then((rows) => { if (!cancelled) setMembers(rows); })
      // Its own state, never "the club has no members": an empty picker after a failed read
      // is the trap this whole release is written against.
      .catch(() => { if (!cancelled) { setMembers([]); setMembersFailed(true); } });
    return () => { cancelled = true; };
  }, []);

  const read = useCallback(async (userId: string, when: string) => {
    setLoading(true);
    try {
      setView(await adminEndpoints.memberTrace(userId, { day: when }));
      setError(null);
    } catch (err) {
      // The previous night is cleared, deliberately and unlike the control board: a timeline
      // for the wrong person or the wrong night is not "stale truth", it is a different fact.
      setView(null);
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Clearing the view when the member is unset IS the synchronisation: what is on screen
  // belongs to a person who is no longer chosen, and on this surface of all surfaces a
  // timeline that outlives its subject for even one paint is the wrong person's night.
  // The read itself is async and every setState inside it runs in a promise callback.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    if (!member) { setView(null); setError(null); return; }
    void read(member.user_id, day);
  }, [member, day, read]);

  const pickable: PickableMember[] = (members ?? []).map((m) => ({
    user_id: m.user_id,
    full_name: m.full_name,
    membership_number: m.membership_number ?? null,
  }));

  const timezone = view?.timezone;
  const events = view?.events ?? [];
  const rows = buildTimeline(events);
  const subjectName = view?.member?.name ?? member?.full_name ?? "this member";
  const caveat = retentionCaveat(view?.retention, timezone);

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight">A person&rsquo;s night</h1>
        <MonitoringNav />
      </header>

      {/* Standing, and said once. It is a fact about the screen somebody has arrived at, not
          an event — and this block re-renders on every read, so `polite` would announce the
          whole paragraph again each time a night is chosen. */}
      <Alert tone="warning" live="standing" announceKey="night-privacy">
        {NIGHT_PRIVACY_NOTICE}
      </Alert>

      <Card className="space-y-4">
        <MemberPicker
          label="Which member?"
          hint="There is nothing to trace for a visitor booked in under a written-in name, so only members appear here."
          members={pickable}
          value={member}
          onChange={setMember}
          loading={members === null}
          failed={membersFailed}
        />

        <div>
          <Label htmlFor="night-day">Which night?</Label>
          {/* Disabled until the first half is answered, and the disabled half SAYS WHY —
              a greyed-out control with no explanation is a dead end somebody stares at. */}
          {!member && <p className="text-sm text-text-muted">{NIGHT_NO_MEMBER_YET}</p>}
          <Input
            id="night-day"
            type="date"
            className="mt-1 min-h-11"
            value={day}
            disabled={!member}
            onChange={(e) => setDay(e.target.value)}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {recentNights(new Date()).map((night) => (
              <Button
                key={night.iso}
                variant="outline"
                className="min-h-11"
                disabled={!member}
                onClick={() => setDay(night.iso)}
              >
                {night.label}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-sm text-text-muted">{nightWindowHint(view?.range, timezone)}</p>
        </div>
      </Card>

      {caveat && <Alert tone="info" live="standing" announceKey={`night-retention:${view?.club_day ?? ""}`}>{caveat}</Alert>}
      {hasApproximateTimes(events) && <p className="text-sm text-text-muted">{APPROXIMATE_EXPLANATION}</p>}

      {member && (
        <StateBlock
          loading={loading}
          error={error}
          action="that night"
          // The one sentence most designs leave out. The server writes its audit row on a
          // 200, so a failed read that still claimed "opening this is recorded" would make
          // the notice above a lie about the only thing this surface promises.
          failedCaveat="Nothing was recorded about this look-up."
          onRetry={() => { if (member) void read(member.user_id, day); }}
          empty={!loading && !error && events.length === 0}
          emptyTitle={nightEmptyNotice(subjectName, clubDate(day, timezone))}
          emptyHint={NIGHT_EMPTY_HINT}
        >
          <div className="space-y-3">
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

            <div className="flex flex-wrap items-center gap-3">
              <a
                className="inline-flex min-h-11 items-center rounded-lg border border-control bg-bg-surface px-4 text-sm font-medium"
                href={adminEndpoints.memberTraceCsvUrl(member.user_id, { day })}
              >
                Download CSV
              </a>
              <p className="min-w-0 flex-1 text-xs text-text-muted">{NIGHT_EXPORT_NOTE}</p>
            </div>
          </div>
        </StateBlock>
      )}
    </div>
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
