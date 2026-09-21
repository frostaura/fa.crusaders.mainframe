import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
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

type Read<T> = { data: T | null; error: unknown; loading: boolean };

/**
 * One read, keyed by the attempt it belongs to.
 *
 * The effect only STARTS a request; everything it learns is set from the promise's own
 * callback. Resetting three states at the top of an effect body is a cascading render the
 * React compiler cannot memoize around, and `react-hooks/set-state-in-effect` is an error in
 * this repo rather than a warning. Keyed, "loading" is the honest sentence "what I am holding
 * is not what I asked for".
 */
function useRead<T>(key: string, load: () => Promise<T>): [Read<T>, () => void] {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{ key: string; data: T | null; error: unknown }>(
    { key: "", data: null, error: null },
  );
  const asked = `${key}:${nonce}`;

  useEffect(() => {
    let live = true;
    load()
      .then((data) => { if (live) setState({ key: asked, data, error: null }); })
      .catch((error) => { if (live) setState({ key: asked, data: null, error }); });
    return () => { live = false; };
  }, [asked, load]);

  const fresh = state.key === asked;
  return [
    { data: fresh ? state.data : null, error: fresh ? state.error : null, loading: !fresh },
    () => setNonce((n) => n + 1),
  ];
}

/** How many courts an occurrence actually holds, or the rule's count where it says nothing. */
function courtsHeldBy(occurrence: ScheduleOccurrence, fallback: number): number {
  return occurrence.courts?.length ?? fallback;
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

  const days = row?.days ?? [];
  const courtCount = row?.courts?.length ?? 0;
  const perOccurrence = row?.start && row?.end
    ? slotsPerOccurrence({ start: row.start, end: row.end }, 15)
    : 0;

  const skipped = (occurrences ?? []).filter((o) => o.status === "skipped");
  const remaining = (occurrences ?? []).filter((o) => o.status === "scheduled");
  // Null, not zero, when we have not read the dates: "releases 0 held slots" is a claim.
  const remainingSlots = occurrences === null ? null : remaining.length * courtCount * perOccurrence;

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
              {occurrences !== null && (() => {
                const partial = partialMaterialisation(
                  occurrences.filter((o) => (o.courts?.length ?? 0) > 0).length,
                  occurrences.filter((o) => o.status !== "skipped").length,
                  days,
                );
                return partial ? <Alert tone="info" live="polite" announceKey="schedule-partial">{partial}</Alert> : null;
              })()}
            </div>

            {clampedTo && (
              <Alert tone="info" live="polite" announceKey={`schedule-clamped-${clampedTo}`}>
                {clampedNotice(clampedTo)}
              </Alert>
            )}
            {notice}

            {/* D3 §5.5's chips: the ONE place a skipped date is restored from. The occurrence
                row below shows the word "Skipped" and no control, because two controls for
                one action is two names for it. */}
            {skipped.length > 0 && (
              <div className="space-y-2">
                <h2 className="text-sm font-semibold text-text-primary">Skipped dates</h2>
                <ul className="flex flex-wrap gap-2">
                  {skipped.map((o) => (
                    <li key={o.date}>
                      <Button
                        variant="outline"
                        className="min-h-11"
                        disabled={busy}
                        onClick={() => { void runWrite(() => adminEndpoints.scheduleOccurrenceUpdate(id, o.date, { skip: false })); }}
                      >
                        {skipChipLabel(o.date)}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

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
                    <li key={o.date} className="space-y-2 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium text-text-primary">{clubDateShort(o.date)}</p>
                          <p className="text-sm text-text-secondary">
                            {`${occurrenceStatusWord(o.status)} · ${courtsHeldBy(o, courtCount)} court${courtsHeldBy(o, courtCount) === 1 ? "" : "s"}`}
                          </p>
                        </div>
                        {o.status === "scheduled" && (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              className="min-h-11"
                              onClick={() => setChanging(changing === o.date ? null : o.date)}
                            >
                              {`Change the hours of ${clubDateShort(o.date)}`}
                            </Button>
                            <ConfirmButton
                              idleLabel={`Skip ${clubDateShort(o.date)}`}
                              tone="danger"
                              disabled={busy}
                              subject={clubDateShort(o.date)}
                              cancelLabel="Keep it"
                              confirmLabel={skipConsequence(courtsHeldBy(o, courtCount), o.date)}
                              focusAfter={() => headingRef.current}
                              onConfirm={() => runWrite(
                                () => adminEndpoints.scheduleOccurrenceUpdate(id, o.date, { skip: true }),
                              )}
                            />
                          </div>
                        )}
                      </div>
                      {changing === o.date && (
                        <OccurrenceChange
                          date={o.date}
                          start={row.start ?? ""}
                          end={row.end ?? ""}
                          busy={busy}
                          error={notice}
                          onCancel={() => setChanging(null)}
                          onSubmit={(choice) => submitChange(o.date, choice)}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </StateBlock>
            </Card>

            {row.status !== "ended" && (
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
                    onChange={(e) => setEndReason(e.target.value)}
                  />
                </div>
                <ConfirmButton
                  idleLabel={`End ${row.name}`}
                  tone="danger"
                  disabled={busy}
                  subject={row.name}
                  cancelLabel="Keep it running"
                  confirmLabel={endConsequence({
                    // Both figures are null together: they come from the same read, and a
                    // count of dates we could not read is not zero.
                    remaining: occurrences === null ? null : remaining.length,
                    days,
                    slots: remainingSlots,
                    refundCredits: 0,
                  })}
                  focusAfter={() => headingRef.current}
                  onConfirm={() => runWrite(
                    () => adminEndpoints.scheduleEnd(id, { reason: endReason.trim() }),
                  )}
                />
              </Card>
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
