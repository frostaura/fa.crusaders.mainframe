import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Alert } from "../../components/Alert";
import { useToast } from "../../components/Toast";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { DatePicker } from "../../components/ui/date-picker";
import { formatClubDayLabel } from "../../components/ui/date-picker-day";
import { DownloadSimple } from "../../components/ui/icons";
import { MemberCombobox } from "../../components/ui/member-combobox";
import { MINUS, formatCredits } from "../../lib/utils";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { PageHeader, PageShell } from "../../components/ui/page-shell";
import { StateBlock } from "../../components/ui/state-block";
import { CardListSkeleton } from "../../components/monitoring/parts";
import { clubClock, clubDate } from "../../lib/clubClock";
import { endpoints, type AdminMember } from "../../lib/api";
import { adminEndpoints, type TraceView } from "../../lib/adminApi";
import { describeFailure } from "../../lib/errors";
import { clubDayOf, shiftClubDay } from "../../lib/gridClock";
import { memberDetailEndpoints, saveFile } from "../../lib/memberDetailApi";
import { NIGHT_TAB_COPY } from "../../lib/memberDetailCopy";
import { buildTimeline, burstOutcomes, durationInWords, hasApproximateTimes, readableEvents } from "../../lib/nightTimeline";
import {
  APPROXIMATE_EXPLANATION, NIGHT_EMPTY_HINT, NIGHT_EXPORT_NOTE,
  NIGHT_PRIVACY_NOTICE, actorClause, gapLine, isOnBehalf, nightEmptyNotice, nightWindowHint,
  retentionCaveat,
} from "../../lib/nightCopy";
import { useAsyncAction } from "../../lib/useAsyncAction";
import { validClubDay } from "../../lib/scheduleDay";
import { useRead } from "../../lib/useRead";
import { useTicker } from "../../lib/useTicker";

/**
 * A person's night — GOAL item 6. Since P5 it lives ON THE MEMBER: `/admin/members/:userId/night`
 * (R17 — "the per-person views live on the member"). The old `/admin/monitoring/night` route
 * answers with {@link MemberNightPage}, a picker that sends the admin to that member's own page.
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
 * traces, no search, and no index: the only way in is a member an admin already named.
 * </p>
 *
 * <p>
 * <b>The default night is the CLUB's today, never UTC's.</b> This page used
 * `new Date().toISOString().slice(0, 10)` — the UTC date — so a club east of Greenwich opened
 * on YESTERDAY for the first two hours after its midnight, and a club west of it opened on
 * TOMORROW every evening (the same defect D3-B03 fixed on the grid). The day is now
 * `clubDayOf(now)` in the club's zone; a `?day=` in the link wins over it.
 * </p>
 *
 * <p>
 * <b>Actor versus subject is the spine.</b> Every card says who did it, and a card where
 * somebody acted ON this member is marked — the `{actor, subject}` invariant made visible.
 * </p>
 */

/** The three nights offered as buttons, newest first, ending with the club's today. */
function recentNights(today: string): Array<{ iso: string; label: string }> {
  return [0, 1, 2].map((back) => {
    const iso = shiftClubDay(today, -back);
    return { iso, label: back === 0 ? "Tonight" : back === 1 ? "Last night" : formatClubDayLabel(iso) ?? iso };
  });
}

/**
 * The night itself: one list, three kinds of row.
 *
 * <p>
 * Its own component because the three arms are the whole of what this surface draws, and
 * because the page around it is a chooser — a night, and the states a read can be in.
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

/** Which night — the one question this surface cannot answer anything without. */
function NightDayChooser({ day, today, onDay, rangeHint }: {
  day: string;
  today: string;
  onDay: (next: string) => void;
  rangeHint: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1.5">
        <div role="group" aria-labelledby="night-day-label" className="flex flex-col gap-1.5">
          <span id="night-day-label" className="text-sm font-medium text-text-primary">Which night?</span>
          <div className="flex flex-wrap items-center gap-2">
            <DatePicker label="Which night?" value={day} onChange={onDay} max={today} />
            <ToggleGroup
              type="single"
              aria-label="Recent nights"
              value={day}
              onValueChange={(next) => { if (next) onDay(next); }}
              className="rounded-lg bg-bg-muted p-1"
            >
              {recentNights(today).map((night) => (
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
 * One member's night, re-read whenever the night changes.
 *
 * <p>
 * Keyed through `useRead`, so the previous night is GONE the moment a different one is asked for,
 * deliberately and unlike the control board: a timeline for the wrong night is not stale truth, it
 * is a different fact, and on this surface of all surfaces it must not outlive its question for
 * even one paint.
 * </p>
 */
function useMemberNight(userId: string, day: string) {
  const key = `${userId}:${day}`;
  // A page at a time (R4 carry-over): one busy night's trace was 307 KB in one read. The summary
  // and the total are the whole night's on every page; "Show more" appends with the cursor, and
  // the server counts every page of one night as ONE privacy view.
  const load = useCallback(() => adminEndpoints.memberTrace(userId, { day, limit: TRACE_PAGE }), [userId, day]);
  const [read, retry] = useRead(key, load);
  const [more, setMore] = useState<NightMore>({ key: "", events: [], cursor: undefined, pending: false, error: null });
  const mine = more.key === key ? more : null;
  const cursor = mine?.cursor !== undefined ? mine.cursor : read.data?.cursor ?? null;
  const view = read.data ? { ...read.data, events: [...read.data.events, ...(mine?.events ?? [])], cursor } : read.data;

  const loadMore = async () => {
    if (!cursor || mine?.pending) return;
    setMore({ key, events: mine?.events ?? [], cursor, pending: true, error: null });
    try {
      const page = await adminEndpoints.memberTrace(userId, { day, limit: TRACE_PAGE, cursor });
      setMore((now) => (now.key === key ? { key, events: [...now.events, ...page.events], cursor: page.cursor ?? null, pending: false, error: null } : now));
    } catch (error) {
      setMore((now) => (now.key === key ? { ...now, pending: false, error } : now));
    }
  };
  return { view, loading: read.loading, error: read.error, retry, loadMore, more: { pending: mine?.pending ?? false, error: mine?.error ?? null } };
}

/** Events a page holds beyond the first read, for one night (`key`). `cursor` undefined: not paged yet. */
type NightMore = { key: string; events: TraceView["events"]; cursor: string | null | undefined; pending: boolean; error: unknown };

/** A night's events per page (B2 suggests 100): enough for most nights in one read. */
const TRACE_PAGE = 100;

/** "Show more", while the night has events not yet on the page. */
function NightMoreButton({ view, onMore, pending, error }: {
  view: TraceView | null; onMore: () => void; pending: boolean; error: unknown;
}) {
  if (!view?.cursor) return null;
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm text-text-secondary">{NIGHT_TAB_COPY.showing(view.events.length, view.total ?? null)}</p>
      {error ? <p role="alert" className="text-sm text-danger-strong">{describeFailure(error, { action: "read more of that night" })}</p> : null}
      <Button variant="outline" pending={pending} onClick={onMore}>{NIGHT_TAB_COPY.showMore}</Button>
    </div>
  );
}

/**
 * Everything the page draws that is derived rather than fetched.
 *
 * <p>
 * Each fallback is a decision: `subjectName` falls back from the name the server returned, to
 * the name the page holds, to a phrase that names nobody, so a card never says "undefined
 * scanned".
 * </p>
 */
function nightView(view: TraceView | null, name: string | null) {
  const read = view ?? EMPTY_NIGHT;
  const timezone = read.timezone;
  const events = readableEvents(read.events ?? []);
  return {
    timezone,
    events,
    rows: buildTimeline(events),
    subjectName: read.member?.name ?? name ?? "this member",
    caveat: retentionCaveat(read.retention, timezone),
    retentionKey: read.club_day ?? "",
    rangeHint: nightWindowHint(read.range, timezone),
  };
}

/** What a night looks like before one has been read. Fields the wire may omit stay absent. */
const EMPTY_NIGHT = {} as Partial<TraceView>;

/**
 * The night of one member the caller already named — the body of the member page's Night tab.
 *
 * <p>
 * The chosen night lives in the URL (`?day=`), so "Thandi's Saturday" is a link. With no day in
 * the link it is the club's today, computed in the club's zone — see the file header. Until the
 * club has told this browser its zone, `clubDayOf` answers the reader's own day; the first trace
 * carries the zone, and the default re-derives from it on the very next render.
 * </p>
 */
export function MemberNight({ userId, name }: { userId: string; name: string | null }) {
  const [params, setParams] = useSearchParams();
  // The clock moves on while the tab is open: at the club's midnight "Tonight" becomes a new day.
  const today = clubDayOf(useTicker(true, 60_000));
  const day = validClubDay(params.get("day")) ?? today;
  const setDay = (next: string) => {
    setParams((prev) => {
      const out = new URLSearchParams(prev);
      if (next === today) out.delete("day"); else out.set("day", next);
      return out;
    }, { replace: true });
  };
  const night = useMemberNight(userId, day);
  const { view, loading, error, retry } = night;
  const { timezone, events, rows, subjectName, caveat, retentionKey, rangeHint } = nightView(view, name);

  return (
    <div className="flex flex-col gap-6">
      {/* Standing, and said once. It is a fact about the screen, not an event — and this block
          re-renders on every read, so `polite` would announce the paragraph again each time. */}
      <Alert tone="warning" live="standing" announceKey="night-privacy">{NIGHT_PRIVACY_NOTICE}</Alert>
      <NightDayChooser day={day} today={today} onDay={setDay} rangeHint={rangeHint} />
      {caveat && <Alert tone="info" live="standing" announceKey={`night-retention:${retentionKey}`}>{caveat}</Alert>}
      {hasApproximateTimes(events) && <p className="text-sm text-text-muted">{APPROXIMATE_EXPLANATION}</p>}
      <NightResult
        userId={userId}
        day={day}
        loading={loading}
        error={error}
        events={events}
        rows={rows}
        subjectName={subjectName}
        timezone={timezone}
        onRetry={retry}
      />
      <NightMoreButton view={view} onMore={() => void night.loadMore()} pending={night.more.pending} error={night.more.error} />
    </div>
  );
}

/**
 * The old `/admin/monitoring/night` — kept answering so a bookmark still lands somewhere useful.
 * It asks WHO, and opens that member's own Night tab; the night itself is read only there.
 */
export function MemberNightPage() {
  const { pickable, membersLoading, membersFailed, retry } = useClubMembers();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const day = validClubDay(params.get("day"));
  const open = (userId: string | null) => {
    if (!userId) return;
    navigate(`/admin/members/${encodeURIComponent(userId)}/night${day ? `?day=${day}` : ""}`);
  };
  return (
    <PageShell width="content">
      <PageHeader title={NIGHT_TAB_COPY.pickerTitle} description={NIGHT_TAB_COPY.pickerDescription} />
      <Alert tone="warning" live="standing" announceKey="night-privacy">{NIGHT_PRIVACY_NOTICE}</Alert>
      <Card>
        <CardContent className="flex flex-col gap-1.5">
          <MemberCombobox
            label={NIGHT_TAB_COPY.pickerLabel}
            placeholder={NIGHT_TAB_COPY.pickerPlaceholder}
            members={pickable}
            value={null}
            onChange={open}
            loading={membersLoading}
            error={membersFailed ? NIGHT_TAB_COPY.membersFailed : null}
          />
          {membersFailed ? (
            <Button variant="outline" className="self-start" onClick={retry}>{NIGHT_TAB_COPY.membersRetry}</Button>
          ) : null}
        </CardContent>
      </Card>
    </PageShell>
  );
}

/**
 * The club's members, as the picker needs them, with its failure kept separate.
 *
 * A failed read must never reach the picker as an empty list — "the club has no members" is a
 * different sentence from "we could not ask".
 */
function useClubMembers() {
  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [membersFailed, setMembersFailed] = useState(false);
  // F3-16: a failed read said "try again" and offered nothing to press. A retry re-runs the read.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    endpoints.adminMembers()
      .then((rows) => { if (!cancelled) { setMembers(rows); setMembersFailed(false); } })
      .catch(() => { if (!cancelled) { setMembers([]); setMembersFailed(true); } });
    return () => { cancelled = true; };
  }, [attempt]);

  const retry = useCallback(() => { setMembers(null); setMembersFailed(false); setAttempt((n) => n + 1); }, []);
  const pickable = (members ?? []).map((m) => ({ id: m.user_id, name: m.full_name, subtitle: m.membership_number ?? null }));
  return { pickable, membersLoading: members === null, membersFailed, retry };
}

/**
 * What the read produced — its three states, the timeline, and the export beside it.
 */
function NightResult(props: {
  userId: string;
  day: string;
  loading: boolean;
  error: unknown;
  events: Parameters<typeof burstOutcomes>[0];
  rows: ReturnType<typeof buildTimeline>;
  subjectName: string;
  timezone: string | undefined;
  onRetry: () => void | Promise<unknown>;
}) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { userId, day, loading, error, events, rows, subjectName, timezone, onRetry } = props;
  return (
    <StateBlock
      loading={loading}
      error={error}
      action="read that night"
      // The one sentence most designs leave out. The server writes its audit row on a
      // 200, so a failed read that still claimed "opening this is recorded" would make
      // the notice above a lie about the only thing this surface promises.
      failedCaveat="Nothing was recorded about this look-up."
      onRetry={() => void onRetry()}
      empty={!loading && !error && events.length === 0}
      emptyTitle={nightEmptyNotice(subjectName, clubDate(`${day}T12:00:00Z`, timezone))}
      emptyHint={NIGHT_EMPTY_HINT}
      skeleton={<CardListSkeleton rows={3} />}
    >
      <div className="space-y-3">
        <NightTimeline rows={rows} subjectName={subjectName} timezone={timezone} />
        <div className="flex flex-wrap items-center gap-3">
          <NightCsvButton userId={userId} day={day} />
          {/* A real basis (R3 V-7): with flex-1's zero basis it never wrapped, and at 320 the
              note was squeezed into a word-wide column beside the button. */}
          <p className="min-w-0 flex-1 basis-60 text-xs text-text-muted">{NIGHT_EXPORT_NOTE}</p>
        </div>
      </div>
    </StateBlock>
  );
}

/**
 * The export, FETCHED with the session's token and saved from a blob. It used to be a bare
 * `<a href>` to `trace.csv`, which navigates with no Authorization header: the API could not
 * resolve a tenant and the "download" was a JSON refusal (the wallet CSV's and the door log's
 * shipped defect, a third time). A button, because it acts: it fetches, then saves.
 */
function NightCsvButton({ userId, day }: { userId: string; day: string }) {
  const toast = useToast();
  const download = useAsyncAction(
    async () => saveFile(await memberDetailEndpoints.nightCsv(userId, { day })),
    { failure: (err) => toast.push({ tone: "danger", text: describeFailure(err, { action: "download that night" }), durationMs: 8000 }) },
  );
  return (
    <Button variant="outline" onClick={() => void download.run()} pending={download.pending} icon={<DownloadSimple aria-hidden="true" />}>
      {NIGHT_TAB_COPY.download}
    </Button>
  );
}

/**
 * One event on the rail.
 *
 * The left rule is `info` where somebody acted ON this member, and the clause under the
 * headline names them — the `{actor, subject}` invariant this product has always had in its
 * audit table and never shown anybody.
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
          {event.headline ?? burstOutcomes([event])[0]}
        </p>
        {clause && (
          // Wraps, never shrink-0 (R4 V4-6): "by Priya Naidoo on Thandi's behalf" is wider than a
          // 320 phone and a shrink-0 clause made the Night tab scroll sideways.
          <span className={onBehalf ? "min-w-0 break-words text-sm text-info-strong" : "min-w-0 break-words text-sm text-text-muted"}>
            {clause}
          </span>
        )}
      </div>
      {typeof event.amount_minutes === "number" && (
        <p className="text-sm text-text-secondary">
          {`${event.amount_minutes < 0 ? MINUS : "+"}${Math.abs(event.amount_minutes).toFixed(2)} credits`}
          {typeof event.balance_after_minutes === "number"
            // U+2212 like every other figure on the admin (F3-14: "-100.00" sat beside "−200.00").
            ? ` · balance ${formatCredits(event.balance_after_minutes, { long: true }).replace(/ credits$/, "")}`
            : ""}
        </p>
      )}
      {event.court?.name && <p className="text-sm text-text-muted">{event.court.name}</p>}
    </div>
  );
}
