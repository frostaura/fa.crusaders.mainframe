import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "../Alert";
import { Button } from "../Button";
import { StateBlock } from "../StateBlock";
import { ConflictPanel } from "./ConflictPanel";
import {
  SentenceCheckbox, SentenceDisclosure, SentenceInput, SentenceSelect, SentenceText,
} from "./SentenceParts";
import { adminEndpoints, WEEKDAYS, type ScheduleBody, type ScheduleConflict, type SchedulePreview, type ScheduleRow, type Weekday } from "../../lib/adminApi";
import { ApiError, endpoints, type AdminCourt, type AdminSettings } from "../../lib/api";
import { describeFailure } from "../../lib/errors";
import {
  CHECK_FAILED, CHECK_STALE, CREATE_LABEL, checkLabel, checkingLabel, consequenceLine,
  courtsPhrase, daysPhrase, nothingInTheWay, scheduleCodes, weekdayPlural,
} from "../../lib/scheduleCopy";
import {
  clubToday, enumerateOccurrences, slotsPerOccurrence, validateRule,
} from "../../lib/scheduleRules";

/**
 * Step 1 of creating a repeating booking: one readable sentence, and what it would do.
 *
 * <p>
 * <b>The Save button does not exist until the check has run, and that is the whole point of
 * this surface.</b> A hold is a write that takes courts away from members for a season; the
 * question "is anything in the way" has a real answer, the server can give it without writing
 * anything, and a screen that offers Create first and reports the collision afterwards has
 * asked an admin to find out by trying. So the footer is `Cancel` · `Check 11 Tuesdays`, and
 * `Create the hold` appears only after a check that came back clear — and disappears again the
 * moment the sentence changes, because a check describes a sentence, not a page.
 * </p>
 *
 * <p>
 * <b>`POST /schedules` re-runs the same dry run, and its refusal is handled separately.</b> The
 * world can change between the check and the save: a member books the 13th while the admin is
 * reading. D2 §11.8 answers `409 schedule_conflicts` with the conflict list, and the honest
 * thing to say is not "that failed" but "something was booked while you were reading, nothing
 * has been created, here is what it is".
 * </p>
 *
 * <p>
 * <b>Two plan kinds, one built.</b> D3 §5.2 offers "hold the courts" and "book for a member".
 * D2's `BookingSchedule` has no member field at all and materialises `AdminBlock` rows only,
 * so there is no wire for the second and no UI for it here. That gap is reported to the
 * backend lane as a wire question rather than closed by inventing a field.
 * </p>
 */

const DEFAULT_START = "18:00";
const DEFAULT_END = "21:00";
const INTERVAL_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];

type Check =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "failed"; error: unknown }
  | { kind: "checked"; preview: SchedulePreview; signature: string };

/** The conflict list off a 409 body — D2 §11.8's `{error, conflicts, occurrences}`. */
function conflictsFromRefusal(err: unknown): ScheduleConflict[] | null {
  if (!(err instanceof ApiError) || err.code !== "schedule_conflicts") return null;
  const payload = err.payload as { conflicts?: unknown } | null;
  return Array.isArray(payload?.conflicts) ? (payload.conflicts as ScheduleConflict[]) : [];
}

export function ScheduleEditor({
  onCreated, onCancel,
}: { onCreated: (row: ScheduleRow) => void; onCancel: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const checkRef = useRef<HTMLDivElement>(null);

  // --- The sentence ----------------------------------------------------------------------
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [days, setDays] = useState<Weekday[]>(["tue"]);
  const [start, setStart] = useState(DEFAULT_START);
  const [end, setEnd] = useState(DEFAULT_END);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [intervalWeeks, setIntervalWeeks] = useState(1);
  const [courtIds, setCourtIds] = useState<string[]>([]);
  const [daysOpen, setDaysOpen] = useState(false);
  const [courtsOpen, setCourtsOpen] = useState(false);

  // --- Prerequisites: which courts exist, and how this club's grid is cut up -------------
  //
  // One state object keyed by the attempt it belongs to, rather than three that an effect
  // resets. The effect below only STARTS a request; everything it learns is set from the
  // promise's own callback. An effect body that calls setState synchronously is a cascading
  // render the React compiler refuses to memoize around (`react-hooks/set-state-in-effect`),
  // and the loading arm falls out of the keys not matching rather than out of a fourth flag.
  const [setupNonce, setSetupNonce] = useState(0);
  const [setup, setSetup] = useState<{
    key: number; courts: AdminCourt[] | null; settings: AdminSettings | null; error: unknown;
  }>({ key: -1, courts: null, settings: null, error: null });

  useEffect(() => {
    let live = true;
    const key = setupNonce;
    Promise.all([endpoints.adminCourtsList(), endpoints.adminSettingsGet()])
      .then(([c, s]) => {
        if (!live) return;
        setSetup({ key, courts: c, settings: s, error: null });
        // The club's own calendar day, as the default first date — set here rather than in a
        // second effect, and only when the admin has not already typed one.
        setStartDate((typed) => typed || clubToday(s.timezone));
      })
      .catch((err) => { if (live) setSetup({ key, courts: null, settings: null, error: err }); });
    return () => { live = false; };
  }, [setupNonce]);

  const { courts, settings } = setup;
  const setupError = setup.error;
  const setupLoading = setup.key !== setupNonce;

  // Focus the editor's own heading when it opens: it replaces the page's controls, and a
  // reader whose focus stayed on the Create button is reading a button that has gone.
  useEffect(() => { headingRef.current?.focus(); }, []);

  const timezone = settings?.timezone;
  const sliceMinutes = settings?.slice_minutes ?? 15;
  const dayStartMinute = settings?.day_start_minute ?? 0;
  const activeCourts = useMemo(() => (courts ?? []).filter((c) => c.is_active), [courts]);

  const body: ScheduleBody = useMemo(() => ({
    name: name.trim(), label: label.trim(), days, start, end,
    startDate, endDate: endDate || null, intervalWeeks, courtIds,
  }), [name, label, days, start, end, startDate, endDate, intervalWeeks, courtIds]);

  const signature = JSON.stringify(body);

  const refusals = useMemo(
    () => validateRule(body, {
      sliceMinutes, dayStartMinute, activeCourtIds: courts ? activeCourts.map((c) => c.id) : undefined,
    }),
    [body, sliceMinutes, dayStartMinute, courts, activeCourts],
  );
  const codes = useMemo(() => scheduleCodes({ sliceMinutes }), [sliceMinutes]);

  const enumeration = useMemo(
    () => enumerateOccurrences({ days, start, end, startDate, endDate: endDate || null, intervalWeeks }),
    [days, start, end, startDate, endDate, intervalWeeks],
  );
  const perOccurrence = slotsPerOccurrence({ start, end }, sliceMinutes);

  const courtNames = useMemo(
    () => activeCourts.filter((c) => courtIds.includes(c.id)).map((c) => c.name),
    [activeCourts, courtIds],
  );

  // --- The check, and the create ---------------------------------------------------------
  const [check, setCheck] = useState<Check>({ kind: "idle" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  /**
   * Something was cancelled since the check came back, so the check describes a club that no
   * longer exists.
   *
   * Kept as a flag beside the check rather than by throwing the check away, which is what this
   * first did: discarding it unmounted the conflict panel and took the per-item result list —
   * the record of whose money had just moved — off the screen with it. A stale check is not a
   * check to forget; it is a check to stop trusting.
   */
  const [clearedSomething, setClearedSomething] = useState(false);

  const stale = check.kind === "checked" && (check.signature !== signature || clearedSomething);
  const conflicts = check.kind === "checked" ? check.preview.conflicts ?? [] : [];

  async function runCheck() {
    setCheck({ kind: "checking" });
    setCreateError(null);
    setClearedSomething(false);
    try {
      const preview = await adminEndpoints.schedulePreview(body);
      setCheck({ kind: "checked", preview, signature: JSON.stringify(body) });
    } catch (err) {
      // Never a Create button after this. A check that did not finish is not evidence that
      // nothing is in the way, and the sentence below says exactly that.
      setCheck({ kind: "failed", error: err });
    }
  }

  async function create() {
    setCreating(true);
    setCreateError(null);
    try {
      const row = await adminEndpoints.scheduleCreate(body);
      onCreated(row);
    } catch (err) {
      const fresh = conflictsFromRefusal(err);
      if (fresh) {
        // The world moved between the check and the press. Replace the check with what the
        // server just saw, so the panel below is describing now rather than a minute ago.
        setCheck({
          kind: "checked",
          preview: { ...(check.kind === "checked" ? check.preview : { occurrences: enumeration.dates.length }), conflicts: fresh },
          signature: JSON.stringify(body),
        });
      }
      setCreateError(err);
    } finally {
      setCreating(false);
    }
  }

  const canCheck = refusals.length === 0 && enumeration.dates.length > 0 && check.kind !== "checking";
  const showCreate = check.kind === "checked" && !stale && conflicts.length === 0;

  return (
    <section aria-labelledby="schedule-editor-heading" className="space-y-5">
      <h2
        id="schedule-editor-heading"
        ref={headingRef}
        tabIndex={-1}
        className="text-xl font-bold tracking-tight text-text-primary focus:outline-none"
      >
        A new repeating booking
      </h2>

      <StateBlock
        loading={setupLoading}
        error={setupError}
        action="the club's courts and settings"
        failedCaveat="Nothing can be held until they can be read."
        onRetry={() => setSetupNonce((n) => n + 1)}
      >
        <div className="space-y-5">
          {/* The sentence. Each field is a native control with a real, visually hidden
              label — a reader tabbing through them hears "Start time, 18:00", which the
              sentence around it cannot convey out of context. */}
          <p className="text-lg leading-loose">
            <SentenceText>Hold </SentenceText>
            <SentenceDisclosure
              label="Courts"
              summary={courtsPhrase(courtNames)}
              open={courtsOpen}
              onToggle={() => setCourtsOpen((o) => !o)}
              invalid={courtIds.length === 0}
            >
              {activeCourts.map((court) => (
                  <SentenceCheckbox
                    key={court.id}
                    checked={courtIds.includes(court.id)}
                    onChange={(next) => setCourtIds((ids) => (
                      next ? [...ids, court.id] : ids.filter((id) => id !== court.id)
                    ))}
                >
                  {court.name}
                </SentenceCheckbox>
              ))}
            </SentenceDisclosure>
            <SentenceText> on </SentenceText>
            <SentenceDisclosure
              label="Days of the week"
              summary={daysPhrase(days)}
              open={daysOpen}
              onToggle={() => setDaysOpen((o) => !o)}
              invalid={days.length === 0}
            >
              {WEEKDAYS.map((day) => (
                  <SentenceCheckbox
                    key={day}
                    checked={days.includes(day)}
                    onChange={(next) => setDays((current) => (
                      next ? [...current, day] : current.filter((d) => d !== day)
                    ))}
                >
                  {weekdayPlural(day)}
                </SentenceCheckbox>
              ))}
            </SentenceDisclosure>
            <SentenceText> from </SentenceText>
            <SentenceInput label="Start time" type="time" value={start} onChange={setStart} />
            <SentenceText> to </SentenceText>
            <SentenceInput label="End time" type="time" value={end} onChange={setEnd} />
            <SentenceText>, called </SentenceText>
            <SentenceInput
              label="What members see on the grid"
              value={label}
              maxLength={128}
              placeholder="League night"
              onChange={setLabel}
              invalid={label.trim().length === 0}
            />
            <SentenceText>, from </SentenceText>
            <SentenceInput label="First date" type="date" value={startDate} onChange={setStartDate} />
            <SentenceText> until </SentenceText>
            <SentenceInput label="Last date (leave empty for no end)" type="date" value={endDate} min={startDate} onChange={setEndDate} />
            <SentenceText>, repeating every </SentenceText>
            <SentenceSelect
              label="Repeat every how many weeks"
              value={String(intervalWeeks)}
              onChange={(v) => setIntervalWeeks(Number(v))}
              options={INTERVAL_OPTIONS.map((n) => ({ value: String(n), label: n === 1 ? "week" : `${n} weeks` }))}
            />
            <SentenceText>. Called </SentenceText>
            <SentenceInput
              label="A name for this repeating booking, for admins"
              value={name}
              maxLength={128}
              placeholder="Tuesday league"
              onChange={setName}
              invalid={name.trim().length < 2}
            />
            <SentenceText> in this list.</SentenceText>
          </p>

          {/* The consequence, regenerated as it is typed. `live="polite"` and not assertive:
              it changes on every keystroke and an assertive region here talks over the field
              the admin is still typing into. */}
          <p role="status" className="rounded-lg bg-bg-muted px-3 py-2.5 text-sm text-text-primary">
            {consequenceLine({
              occurrences: enumeration.dates.length,
              days,
              courtCount: courtIds.length,
              slotsPerOccurrence: perOccurrence,
              label: label.trim(),
              truncated: enumeration.truncated,
              openEnded: enumeration.openEnded,
              horizonDays: 60,
            })}
          </p>

          {refusals.length > 0 && (
            <Alert tone="warning" live="polite" announceKey="schedule-rule-refusal">
              {codes[refusals[0].code] ?? "That sentence cannot be used yet."}
            </Alert>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="min-h-11" onClick={onCancel}>Cancel</Button>
            <Button
              className="min-h-11"
              disabled={!canCheck}
              loading={check.kind === "checking"}
              onClick={runCheck}
            >
              {check.kind === "checking"
                ? checkingLabel(enumeration.dates.length, days)
                : checkLabel(enumeration.dates.length, days)}
            </Button>
          </div>

          <div ref={checkRef} className="space-y-4">
            {check.kind === "failed" && (
              <Alert tone="danger" live="polite">
                {`${describeFailure(check.error, { action: "check those dates", codes })} ${CHECK_FAILED}`}
              </Alert>
            )}

            {stale && <Alert tone="warning" live="polite" announceKey="schedule-check-stale">{CHECK_STALE}</Alert>}

            {check.kind === "checked" && !stale && conflicts.length === 0 && (
              <Alert tone="success" live="polite">
                {nothingInTheWay({
                  slots: (check.preview.occurrences ?? enumeration.dates.length) * courtIds.length * perOccurrence,
                  occurrences: check.preview.occurrences ?? enumeration.dates.length,
                  days,
                })}
              </Alert>
            )}

            {/* Rendered whether or not the check has gone stale: once bookings have been
                cancelled from here, this panel holds the record of it. */}
            {check.kind === "checked" && conflicts.length > 0 && (
              <ConflictPanel
                conflicts={conflicts}
                timezone={timezone}
                onCleared={() => setClearedSomething(true)}
              />
            )}

            {createError !== null && (
              <Alert tone="danger" live="polite">
                {describeFailure(createError, { action: "create that repeating booking", codes })}
              </Alert>
            )}

            {showCreate && (
              <div className="flex flex-wrap gap-2">
                <Button className="min-h-11" loading={creating} onClick={create}>{CREATE_LABEL}</Button>
              </div>
            )}
          </div>
        </div>
      </StateBlock>
    </section>
  );
}
