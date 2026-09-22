import { useCallback, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useRead } from "../lib/useRead";
import { Alert } from "../components/Alert";
import { Badge, Button, Input, Label } from "../components/Button";
import { Card } from "../components/Card";
import { ConfirmButton } from "../components/ConfirmButton";
import { StateBlock } from "../components/StateBlock";
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
 * The skip control is a `ConfirmButton` and the restore is a chip ABOVE the list, never a
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
          <li className="space-y-2 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-text-primary">{clubDateShort(occurrence.date)}</p>
                <p className="text-sm text-text-secondary">
                  {`${occurrenceStatusWord(occurrence.status)} · ${courtsHeldBy(occurrence, courtCount)} court${courtsHeldBy(occurrence, courtCount) === 1 ? "" : "s"}`}
                </p>
              </div>
              {occurrence.status === "scheduled" && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={onToggleChange}
                  >
                    {`Change the hours of ${clubDateShort(occurrence.date)}`}
                  </Button>
                  <ConfirmButton
                    idleLabel={`Skip ${clubDateShort(occurrence.date)}`}
                    tone="danger"
                    disabled={busy}
                    subject={clubDateShort(occurrence.date)}
                    cancelLabel="Keep it"
                    confirmLabel={skipConsequence(courtsHeldBy(occurrence, courtCount), occurrence.date)}
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
          <Card className="space-y-3 p-4">
            <h2 className="text-lg font-semibold text-text-primary">End this repeating booking</h2>
            <p className="text-sm text-text-secondary">
              {"There is no delete. A repeating booking that has run is part of the club's "}
              {"history: ending it releases the dates still ahead and leaves the ones that "}
              {"already happened exactly as they are."}
            </p>
            <div className="space-y-1">
              <Label htmlFor="end-reason">Reason for ending (kept in the change record)</Label>
              <Input
                id="end-reason"
                value={endReason}
                maxLength={512}
                onChange={(e) => onEndReason(e.target.value)}
              />
            </div>
            <ConfirmButton
              idleLabel={`End ${row.name}`}
              tone="danger"
              disabled={busy}
              subject={row.name}
              cancelLabel="Keep it running"
              confirmLabel={consequence}
              focusAfter={focusAfter}
              onConfirm={onEnd}
            />
          </Card>
  );
}

/**
 * What this repeating booking IS, said once at the top.
 *
 * <p>
 * The `<h1>` carries the ref because it is where focus goes after every write — a confirm that
 * completes and leaves focus on a control that has just been replaced is how a keyboard user
 * loses their place — so the page owns the ref and this component only mounts it.
 * </p>
 *
 * <p>
 * `partial` is computed by the page rather than here: it needs the occurrence read, and
 * "we could not read the dates" must not be rendered as "it holds none".
 * </p>
 */
function ScheduleHeadline({ row, days, headingRef, partial }: {
  row: ScheduleRow;
  days: NonNullable<ScheduleRow["days"]>;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  partial: string | null;
}) {
  return (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold tracking-tight text-text-primary focus:outline-none">
                {row.name}
              </h1>
              {row.status === "ended" && <Badge tone="muted">Ended</Badge>}
            </div>
            <p className="text-text-secondary">
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
            </p>
            <p className="text-sm text-text-muted">{nextOccurrenceLine(row.next_occurrence, row.status)}</p>
            {partial && <Alert tone="info" live="polite" announceKey="schedule-partial">{partial}</Alert>}
          </div>
  );
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
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-text-primary">Skipped dates</h2>
            <ul className="flex flex-wrap gap-2">
              {skipped.map((o) => (
                <li key={o.date}>
                  <Button
                    variant="outline"
                    className="min-h-11"
                    disabled={busy}
                    onClick={() => onRestore(o.date)}
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
  const headingRef = useRef<HTMLHeadingElement>(null);

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

  return (
    <div className="space-y-6">
      <p>
        <Link to="/admin/schedules" className="text-sm text-accent-strong underline">
          All repeating bookings
        </Link>
      </p>

      <StateBlock
        loading={scheduleRead.loading}
        error={scheduleRead.error}
        action="this repeating booking"
        codes={codes}
        onRetry={reloadSchedule}
      >
        {row && (
          <div className="space-y-6">
            <ScheduleHeadline
              row={row}
              days={days}
              headingRef={headingRef}
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

            <Card className="space-y-4 p-4">
              <h2 className="text-lg font-semibold text-text-primary">The dates it holds</h2>
              <StateBlock
                loading={occurrencesRead.loading}
                error={occurrencesRead.error}
                action="the dates this holds"
                codes={codes}
                failedCaveat="That does not mean it holds none."
                onRetry={reloadOccurrences}
                empty={occurrences !== null && occurrences.length === 0}
                emptyTitle="No dates yet."
                emptyHint="They are written a few weeks ahead, so a new one can take a minute to appear."
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
                      focusAfter={() => headingRef.current}
                      notice={notice}
                    />
                  ))}
                </ul>
              </StateBlock>
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
                focusAfter={() => headingRef.current}
                onEnd={() => runWrite(() => adminEndpoints.scheduleEnd(id, { reason: endReason.trim() }))}
              />
            )}

            <Card className="p-4">
              <ScheduleChangeList
                page={changesRead.data}
                loading={changesRead.loading}
                error={changesRead.error}
                onRetry={reloadChanges}
              />
            </Card>
          </div>
        )}
      </StateBlock>
    </div>
  );
}
