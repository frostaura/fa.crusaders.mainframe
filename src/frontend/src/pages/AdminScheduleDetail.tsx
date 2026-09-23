import { useCallback, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useRead } from "../lib/useRead";
import { Alert } from "../components/Alert";
import { ConfirmDialog } from "../components/admin/ConfirmDialog";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { StateBlock } from "../components/ui/state-block";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { Skeleton } from "../components/ui/skeleton";
import { Badge } from "../components/ui/badge";
import { ArrowCounterClockwise, CalendarDots, PencilSimple } from "../components/ui/icons";
import { OccurrenceChange, type EditScope } from "../components/schedules/OccurrenceChange";
import { ScheduleChangeList } from "../components/schedules/ScheduleChangeList";
import {
  adminEndpoints, type AdminChangePage, type ScheduleOccurrence, type ScheduleRow,
} from "../lib/adminApi";
import { describeFailure } from "../lib/errors";
import {
  clampedNotice, clubDateShort, endConsequence, nextOccurrenceLine, occurrenceStatusWord,
  partialMaterialisation, ruleSentence, scheduleCodes, skipChipLabel, skipConsequence,
} from "../lib/scheduleCopy";
import { slotsPerOccurrence } from "../lib/scheduleRules";

/**
 * One repeating booking: what it holds, what has been changed about it, and how to change it.
 *
 * <p>
 * <b>There is no delete on this page, and its absence is the design.</b> D2 §11.5: a schedule
 * that ran is history, and ENDING it is the operation — the schedule row and every past
 * occurrence survive, and only the unstarted rows are released. A delete button here would be
 * a control that destroys the evidence of what the club did to its members' bookings, which is
 * the one thing GOAL item 14 asks for by name.
 * </p>
 *
 * <p>
 * <b>Two ways to change it, and the third fact stated whether or not anybody asked.</b> Only
 * this date writes a `BookingScheduleException`; this-and-future rewrites every unstarted row
 * from that date. The dates already played never change either way, mechanically — every
 * re-materialisation query in D2 is `WHERE StartsAt > now()` — and `OccurrenceChange` says so.
 * </p>
 */

/** How many courts an occurrence actually holds, or the rule's count where it says nothing. */
function courtsHeldBy(occurrence: ScheduleOccurrence, fallback: number): number {
  return occurrence.courts?.length ?? fallback;
}

/**
 * One date this repeating booking holds, and what may be done to it.
 *
 * <p>
 * Its own component because the page around it was a 271-line render against a 200-line gate,
 * and this row is where most of the branching lived: a status word, a court count that
 * pluralises, two controls that exist only while the date is still scheduled, and an inline
 * editor that opens under it. None of that is the page's business.
 * </p>
 *
 * <p>
 * The skip control opens a confirm dialog and the restore is a chip ABOVE the list, never a
 * second control here: two controls for one action are two names for it (D3 §5.5).
 * </p>
 */
function OccurrenceRow({
  occurrence, courtCount, row, busy, changing,
  onToggleChange, onCancelChange, onSubmitChange, onSkip, focusAfter, notice,
}: {
  occurrence: ScheduleOccurrence;
  courtCount: number;
  row: ScheduleRow;
  busy: boolean;
  changing: boolean;
  onToggleChange: () => void;
  onCancelChange: () => void;
  onSubmitChange: Parameters<typeof OccurrenceChange>[0]["onSubmit"];
  onSkip: () => string | void | Promise<string | void>;
  focusAfter: () => HTMLElement | null;
  notice: React.ReactNode;
}) {
  return (
          <li className="flex flex-col gap-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-text-primary">{clubDateShort(occurrence.date)}</p>
                <p className="text-sm text-text-secondary">
                  {`${occurrenceStatusWord(occurrence.status)} · ${courtsHeldBy(occurrence, courtCount)} court${courtsHeldBy(occurrence, courtCount) === 1 ? "" : "s"}`}
                </p>
              </div>
              {occurrence.status === "scheduled" && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    aria-expanded={changing}
                    onClick={onToggleChange}
                    icon={<PencilSimple aria-hidden="true" />}
                  >
                    {`Change the hours of ${clubDateShort(occurrence.date)}`}
                  </Button>
                  <ConfirmDialog
                    trigger={<Button variant="danger-soft" size="sm" disabled={busy}>{`Skip ${clubDateShort(occurrence.date)}`}</Button>}
                    title={`Skip ${clubDateShort(occurrence.date)}?`}
                    description={skipConsequence(courtsHeldBy(occurrence, courtCount), occurrence.date)}
                    confirmLabel={`Skip ${clubDateShort(occurrence.date)}`}
                    cancelLabel="Keep it"
                    focusAfter={focusAfter}
                    onConfirm={onSkip}
                  />
                </div>
              )}
            </div>
            {changing && (
              <OccurrenceChange
                date={occurrence.date}
                start={row.start ?? ""}
                end={row.end ?? ""}
                busy={busy}
                error={notice}
                onCancel={onCancelChange}
                onSubmit={onSubmitChange}
              />
            )}
          </li>
  );
}

/**
 * Ending a repeating booking — which is the only way one ever stops.
 *
 * <p>
 * There is no delete, and the card says so: a repeating booking that has run is part of the
 * club's history, so ending it releases the dates still ahead and leaves the ones that already
 * happened exactly as they are. The reason is kept in the change record, which is why it is a
 * field here rather than a confirm-dialog afterthought.
 * </p>
 *
 * <p>
 * The consequence sentence is computed by the page and passed in: it needs the occurrence read
 * to say how many dates are still ahead, and "we could not read them" must not render as zero.
 * </p>
 */
function EndScheduleCard({ row, busy, endReason, onEndReason, consequence, focusAfter, onEnd }: {
  row: ScheduleRow;
  busy: boolean;
  endReason: string;
  onEndReason: (next: string) => void;
  consequence: string;
  focusAfter: () => HTMLElement | null;
  onEnd: () => string | void | Promise<string | void>;
}) {
  return (
          <Card>
            <CardHeader>
              <CardTitle asChild><h2>End this repeating booking</h2></CardTitle>
              <CardDescription>
                {"There is no delete. A repeating booking that has run is part of the club's "}
                {"history: ending it releases the dates still ahead and leaves the ones that "}
                {"already happened exactly as they are."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Field>
                <FieldLabel>Reason for ending (kept in the change record)</FieldLabel>
                <Input value={endReason} maxLength={512} onChange={(e) => onEndReason(e.target.value)} />
              </Field>
              <ConfirmDialog
                trigger={<Button variant="danger" className="self-start" disabled={busy}>{`End ${row.name}`}</Button>}
                title={`End ${row.name}?`}
                description={consequence}
                confirmLabel={`End ${row.name}`}
                cancelLabel="Keep it running"
                focusAfter={focusAfter}
                onConfirm={onEnd}
              />
            </CardContent>
          </Card>
  );
}

/**
 * What this repeating booking IS, said once at the top — as the page header (R11).
 *
 * <p>
 * Focus goes to the `<h1>` after every write — a confirm that completes and leaves focus on a
 * control that has just been replaced is how a keyboard user loses their place. The header's
 * `<h1>` is `PageHeader`'s, so the page finds it through its shell and makes it programmatically
 * focusable, rather than owning a second heading.
 * </p>
 *
 * <p>
 * `partial` is computed by the page rather than here: it needs the occurrence read, and
 * "we could not read the dates" must not be rendered as "it holds none".
 * </p>
 */
function ScheduleHeadline({ row, days, partial }: {
  row: ScheduleRow;
  days: NonNullable<ScheduleRow["days"]>;
  partial: string | null;
}) {
  return (
    <>
      <PageHeader
        back={BACK}
        title={row.name}
        // A word, not a colour: "Ended" is the state, and the badge carries the word.
        actions={row.status === "ended" ? <Badge tone="neutral">Ended</Badge> : undefined}
        description={(
          <>
            <span className="block text-base text-text-secondary">
              {ruleSentence({
                courtNames: (row.courts ?? []).map((c) => c.name),
                days,
                start: row.start ?? "",
                end: row.end ?? "",
                label: row.label,
                startDate: row.start_date ?? "",
                endDate: row.end_date,
                intervalWeeks: row.interval_weeks,
              })}
            </span>
            <span className="mt-1 block text-text-muted">{nextOccurrenceLine(row.next_occurrence, row.status)}</span>
          </>
        )}
      />
      {partial && <Alert tone="info" live="polite" announceKey="schedule-partial">{partial}</Alert>}
    </>
  );
}

const BACK = { to: "/admin/schedules", label: "Repeating bookings" };

/** The page's `<h1>`, made focusable for a programmatic move (it is not in the tab order). */
function headingIn(shell: HTMLElement | null): HTMLElement | null {
  const heading = shell?.querySelector<HTMLElement>("h1") ?? null;
  if (heading && !heading.hasAttribute("tabindex")) heading.tabIndex = -1;
  return heading;
}

/**
 * D3 §5.5's chips: the ONE place a skipped date is restored from.
 *
 * The occurrence row below shows the word "Skipped" and offers no control, because two
 * controls for one action are two names for it. Renders nothing when there is nothing skipped,
 * so the page does not need a guard around it.
 */
function SkippedDateChips({ skipped, busy, onRestore }: {
  skipped: ScheduleOccurrence[];
  busy: boolean;
  onRestore: (date: string) => void;
}) {
  if (skipped.length === 0) return null;
  return (
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-text-primary">Skipped dates</h2>
            <ul className="flex flex-wrap gap-2">
              {skipped.map((o) => (
                <li key={o.date}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => onRestore(o.date)}
                    icon={<ArrowCounterClockwise aria-hidden="true" />}
                  >
                    {skipChipLabel(o.date)}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
  );
}

/**
 * What this repeating booking holds, counted once.
 *
 * <p>
 * <b>`remainingSlots` is null and never zero while the dates are unread.</b> The end-confirm
 * says how many held slots ending it releases, and "releases 0 held slots" is a claim about
 * the club rather than a fact about the request — the admin would press it believing nothing
 * is being given back. The two come from the same read, so they are absent together.
 * </p>
 */
function scheduleFacts(row: ScheduleRow | null, occurrences: ScheduleOccurrence[] | null) {
  const days = row?.days ?? [];
  const courtCount = row?.courts?.length ?? 0;
  const perOccurrence = row?.start && row?.end
    ? slotsPerOccurrence({ start: row.start, end: row.end }, 15)
    : 0;
  const held = occurrences ?? [];
  const remaining = held.filter((o) => o.status === "scheduled");
  return {
    days,
    courtCount,
    skipped: held.filter((o) => o.status === "skipped"),
    remaining,
    remainingSlots: occurrences === null ? null : remaining.length * courtCount * perOccurrence,
  };
}

export function AdminScheduleDetailPage() {
  const { id = "" } = useParams();

  const loadSchedule = useCallback(() => adminEndpoints.schedule(id), [id]);
  const loadOccurrences = useCallback(() => adminEndpoints.scheduleOccurrences(id), [id]);
  const loadChanges = useCallback(() => adminEndpoints.scheduleChanges(id), [id]);

  const [scheduleRead, reloadSchedule] = useRead<ScheduleRow>(id, loadSchedule);
  const [occurrencesRead, reloadOccurrences] =
    useRead<{ occurrences: ScheduleOccurrence[] }>(id, loadOccurrences);
  const [changesRead, reloadChanges] = useRead<AdminChangePage>(id, loadChanges);

  const [changing, setChanging] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<unknown>(null);
  const [clampedTo, setClampedTo] = useState<string | null>(null);
  const [endReason, setEndReason] = useState("");
  const shellRef = useRef<HTMLDivElement>(null);
  const focusHeading = useCallback(() => headingIn(shellRef.current), []);

  const row = scheduleRead.data;
  const occurrences = occurrencesRead.data?.occurrences ?? null;
  const codes = useMemo(() => scheduleCodes({}), []);

  const { days, courtCount, skipped, remaining, remainingSlots } = scheduleFacts(row, occurrences);

  /** Every write on this page refreshes the same three reads and clears the same notice. */
  const afterWrite = useCallback(() => {
    reloadSchedule();
    reloadOccurrences();
    reloadChanges();
  }, [reloadSchedule, reloadOccurrences, reloadChanges]);

  async function runWrite(work: () => Promise<{ effective_from_clamped_to?: string } | unknown>): Promise<string> {
    setBusy(true);
    setWriteError(null);
    setClampedTo(null);
    try {
      const result = await work() as { effective_from_clamped_to?: string } | null;
      // `effective_from` is clamped, never refused — an admin typing last Tuesday means "from
      // now on" — and the screen has to say it moved, or the admin believes the past changed.
      if (result?.effective_from_clamped_to) setClampedTo(result.effective_from_clamped_to);
      setChanging(null);
      afterWrite();
      return "Done.";
    } catch (err) {
      setWriteError(err);
      return "That did not happen.";
    } finally {
      setBusy(false);
    }
  }

  function submitChange(date: string, choice: { scope: EditScope; start: string; end: string; reason: string }) {
    void runWrite(() => (choice.scope === "only"
      ? adminEndpoints.scheduleOccurrenceUpdate(id, date, {
        start: choice.start, end: choice.end, reason: choice.reason,
      })
      : adminEndpoints.scheduleUpdate(id, {
        start: choice.start, end: choice.end, effectiveFrom: date,
      })));
  }

  const notice = writeError !== null ? (
    <Alert tone="danger" live="polite" announceKey="schedule-write">
      {describeFailure(writeError, { action: "change that repeating booking", codes })}
    </Alert>
  ) : null;

  if (!row) {
    return (
      <PageShell width="wide">
        {scheduleRead.loading ? null : <PageHeader back={BACK} title="Repeating booking" />}
        <StateBlock
          loading={scheduleRead.loading}
          error={scheduleRead.error}
          action="this repeating booking"
          codes={codes}
          onRetry={reloadSchedule}
          skeleton={<DetailSkeleton />}
        />
      </PageShell>
    );
  }

  return (
    <PageShell width="wide" ref={shellRef}>
      <ScheduleHeadline
        row={row}
        days={days}
        partial={occurrences === null ? null : partialMaterialisation(
          occurrences.filter((o) => (o.courts?.length ?? 0) > 0).length,
          occurrences.filter((o) => o.status !== "skipped").length,
          days,
        )}
      />

      {clampedTo && (
        <Alert tone="info" live="polite" announceKey={`schedule-clamped-${clampedTo}`}>
          {clampedNotice(clampedTo)}
        </Alert>
      )}
      {notice}

      {/* D3 §5.5's chips: the ONE place a skipped date is restored from. The occurrence
          row below shows the word "Skipped" and no control, because two controls for
          one action is two names for it. */}
      <SkippedDateChips
        skipped={skipped}
        busy={busy}
        onRestore={(date) => { void runWrite(() => adminEndpoints.scheduleOccurrenceUpdate(id, date, { skip: false })); }}
      />

      <Card>
        <CardHeader><CardTitle asChild><h2>The dates it holds</h2></CardTitle></CardHeader>
        <CardContent>
        <StateBlock
          loading={occurrencesRead.loading}
          error={occurrencesRead.error}
          action="the dates this holds"
          codes={codes}
          failedCaveat="That does not mean it holds none."
          onRetry={reloadOccurrences}
          empty={occurrences !== null && occurrences.length === 0}
          emptyIcon={CalendarDots}
          emptyTitle="No dates yet."
          emptyHint="They are written a few weeks ahead, so a new one can take a minute to appear."
          skeleton={<RowsSkeleton />}
        >
          <ul className="divide-y divide-border">
            {(occurrences ?? []).map((o) => (
              <OccurrenceRow
                key={o.date}
                occurrence={o}
                courtCount={courtCount}
                row={row}
                busy={busy}
                changing={changing === o.date}
                onToggleChange={() => setChanging(changing === o.date ? null : o.date)}
                onCancelChange={() => setChanging(null)}
                onSubmitChange={(choice) => submitChange(o.date, choice)}
                onSkip={() => runWrite(
                  () => adminEndpoints.scheduleOccurrenceUpdate(id, o.date, { skip: true }),
                )}
                focusAfter={focusHeading}
                notice={notice}
              />
            ))}
          </ul>
        </StateBlock>
        </CardContent>
      </Card>

      {row.status !== "ended" && (
        <EndScheduleCard
          row={row}
          busy={busy}
          endReason={endReason}
          onEndReason={setEndReason}
          consequence={endConsequence({
            // Both figures are null together: they come from the same read, and a count
            // of dates we could not read is not zero.
            remaining: occurrences === null ? null : remaining.length,
            days,
            slots: remainingSlots,
            refundCredits: 0,
          })}
          focusAfter={focusHeading}
          onEnd={() => runWrite(() => adminEndpoints.scheduleEnd(id, { reason: endReason.trim() }))}
        />
      )}

      <Card>
        <CardContent>
          <ScheduleChangeList
            page={changesRead.data}
            loading={changesRead.loading}
            error={changesRead.error}
            onRetry={reloadChanges}
          />
        </CardContent>
      </Card>
    </PageShell>
  );
}

/** The page, loading: a header and two cards' worth of rows (R12 — never "Loading…"). */
function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

/** The dates list, loading. */
function RowsSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
    </div>
  );
}
