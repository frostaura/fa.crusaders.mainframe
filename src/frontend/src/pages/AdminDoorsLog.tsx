import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Panel as Card } from "../components/ui/card";
import { Alert } from "../components/Alert";
import { Button } from "../components/ui/button";
import { DatePicker } from "../components/ui/date-picker";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "../components/ui/select";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { RefreshButton } from "../components/ui/refresh-button";
import { TextLink } from "../components/ui/text-link";
import { DownloadSimple } from "../components/ui/icons";
import { useToast } from "../components/toastContext";
import { DoorFeedRow } from "../components/doors/DoorFeedRow";
import { useTicker } from "../lib/useTicker";
import {
  LOG_CSV_BLOCKED_DOOR_GONE, LOG_DOOR_GONE, LOG_DOOR_GONE_HINT, LOG_EMPTY_FILTERED,
  LOG_EMPTY_FILTERED_HINT, LOG_EMPTY_NOTHING, LOG_OLDER_FAILED, LOG_PICK_A_DAY, LOG_READ_FAILED,
  OFFLINE_WHO_NOTE, doorCsvDownloaded, doorCsvFailed, doorCsvNotice, doorDisplayName,
  doorExhaustedNotice, doorLogCountLine, doorLogEmptyOneDoor, doorLogHeading, doorLogHowToRead,
  doorPickerLabel, doorRetentionNotice, doorRowIdentity, doorRowName, removedDoorName,
  removedDoorsCapNotice,
} from "../lib/doorsCopy";
import { clubClock, clubDayAndClock, clubRangeInWords } from "../lib/clubClock";
import { isOnline, offlineAfterSecondsFor } from "../lib/deviceLiveness";
import { DOOR_OUTCOME_CHIPS, isDoorScan } from "../lib/deviceActivity";
import { describeDeviceError } from "../lib/deviceErrors";
import { withDoorsBoundary } from "../components/doors/withDoorsBoundary";
import {
  ApiError, doorEndpoints, type DoorLogEntry, type DoorLogFilters, type DoorLogPeriod,
  type DoorsView, type RemovedDoor,
} from "../lib/api";

/**
 * All scans, all doors — the committee's question after a break-in, and the desk's question
 * the spec predicted: "nobody could get in through the side door all Tuesday."
 *
 * <p>
 * <b>This is deliberately NOT a `DataTable`, and that needs saying out loud or the next round
 * "fixes" it.</b> `DataTable`'s `search` prop filters rows by whatever `search.fields(row)`
 * returns; on a door log that string contains the member's name, so the log would ship with a
 * free-text per-member filter — P3 broken by a component default rather than by a decision
 * anybody made (A2.7 names this explicitly). Its sort control is the second problem: a door
 * log is inherently newest-first, and sorting it by the who column is the same filter in a
 * different shape.
 * </p>
 *
 * <p>
 * <b>Filters live in the query string</b>, which is what lets a door page pre-filter, lets an
 * admin send a committee member a link to Tuesday night, and makes the back button behave.
 * </p>
 *
 * <p>
 * <b>It does not poll.</b> A list that re-sorts under a reader's finger while they read it is
 * worse than one thirty seconds old. It says when it was read and offers to look again.
 * </p>
 */

/**
 * <b>A4 — the six ways a club actually asks "when".</b>
 *
 * <p>
 * The page offered three rolling windows and nothing else, so there was no way to ask for
 * yesterday or for one particular day: a chair exporting "yesterday's" scans after an
 * incident was handed half of yesterday and half of today, and nothing on the page or in the
 * filename said so. Today, Yesterday and a specific day are CALENDAR questions and the club's
 * midnight is the server's to compute — a browser's is a different instant for any admin
 * travelling or with a device clock that is out.
 * </p>
 *
 * <p>
 * The URL values are kept short and the wire values are WIRE-R2 §3's, so an existing
 * `?range=24h` link a committee member was sent still resolves to the same window.
 * </p>
 */
const RANGES: { value: string; label: string; period: DoorLogPeriod | null }[] = [
  { value: "today", label: "Today", period: "today" },
  { value: "yesterday", label: "Yesterday", period: "yesterday" },
  { value: "24h", label: "Last 24 hours", period: "last_24h" },
  { value: "7d", label: "Last 7 days", period: "last_7d" },
  { value: "30d", label: "Last 30 days", period: "last_30d" },
  // `period: null` — this one carries its answer in `?day=` instead.
  { value: "day", label: "A specific day", period: null },
];

const DEFAULT_RANGE = "24h";

function periodFor(range: string): DoorLogPeriod {
  return RANGES.find((r) => r.value === range)?.period ?? "last_24h";
}

/** `YYYY-MM-DD`, which is the only thing the API accepts and the only thing a date input emits. */
function isClubDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * The filters as the request carries them — one source for the list AND the CSV.
 *
 * <p>
 * <b>It no longer computes a `from`.</b> It used to build "now minus 24 hours" on the client,
 * which is a second opinion about the club's day and a different instant every time it is
 * called — the CSV had to be handed the list's own copy for exactly that reason. The range is
 * the server's now, one parameter, resolved in the club's zone, and the page states back what
 * the server says it resolved rather than what it asked for.
 * </p>
 *
 * <p>
 * `period`, `day` and from/to are mutually exclusive — more than one is a 400 `range_conflict`
 * — so exactly one is ever sent.
 * </p>
 */
function filtersOf(params: URLSearchParams): DoorLogFilters {
  const door = params.get("door") ?? undefined;
  const removedDoor = params.get("removed_door") ?? undefined;
  const outcome = (params.get("outcome") ?? undefined) as DoorLogFilters["outcome"];
  const reason = params.get("reason") ?? undefined;
  const range = params.get("range") ?? DEFAULT_RANGE;
  const day = params.get("day") ?? "";
  // A malformed `?day=` is not sent at all: the API answers 400 `day_invalid` and the page
  // has no business turning a typo in a shared link into a failed read.
  const when: DoorLogFilters = range === "day" && isClubDay(day)
    ? { day }
    : { period: periodFor(range) };
  // A2: a removed door has no id, so it is filtered by the key its rows stored. Never both.
  const which = removedDoor ? { removed_door: removedDoor } : { door };
  return { ...which, outcome, reason, ...when };
}

/**
 * <b>A-L3 / R3-12 — "A specific day" with no day chosen is not a question yet.</b>
 *
 * <p>
 * {@link filtersOf} falls back to the default period, which is right for the REQUEST and
 * wrong for the page: the rows that came back were the last 24 hours, the When control said
 * "A specific day", and nothing on the screen reconciled the two. A rolling window presented
 * as a calendar day is the same class of falsehood A4 was raised on, one control along.
 * </p>
 */
function awaitingDay(params: URLSearchParams): boolean {
  return (params.get("range") ?? DEFAULT_RANGE) === "day" && !isClubDay(params.get("day") ?? "");
}

/**
 * Which empty sentence is true here — narrowed, one door, or genuinely nothing.
 *
 * C7: the one-door sentence used to assert "its board may not be reaching the club" whatever
 * the door was doing, so an admin filtering a perfectly healthy door to an empty range was
 * sent to look for a fault that did not exist. `online` is that door's real liveness, read
 * from the same doors view the picker's options come from.
 */
function emptySentence(
  params: URLSearchParams, doorName: string | null, online: boolean | null,
  range: { from: string; to: string } | null, timezone: string | undefined,
): string[] {
  if (doorName) {
    // B20: the boundary carries its date. "Fri 18:40" against a 30-day range names four
    // Fridays and the reader cannot tell which one the filter starts at.
    // A4: and it is the range the SERVER resolved, not a second client-side "24 hours ago" —
    // that was a different instant from the one the rows were read with.
    const face = range ? clubDayAndClock(range.from, timezone) : "the start of this range";
    return [doorLogEmptyOneDoor(doorName, face, online)];
  }
  const narrowed = (params.get("outcome") ?? "") !== "" || (params.get("reason") ?? "") !== ""
    || (params.get("range") ?? DEFAULT_RANGE) !== DEFAULT_RANGE;
  if (narrowed) return [LOG_EMPTY_FILTERED, LOG_EMPTY_FILTERED_HINT];
  return [LOG_EMPTY_NOTHING];
}

/** One option in the door picker. The display NAME is mandatory; the slug may be absent. */
type PickerDoor = { id: string; name: string; gate_key: string | null };

/**
 * The doors the picker offers — from the doors read, or from the rows on screen (A6).
 *
 * <p>
 * With the doors read failed the picker silently collapsed to "All doors" alone, which is
 * indistinguishable from a club that has one door, and a `?door=` already in the URL had no
 * option to select so the control read "All doors" while the list was filtered to one. The
 * rows themselves each carry `{id, name, gate_key}` for their own door, so a filtered view
 * can always name at least the doors it is showing. The page says beside the control that
 * the list may be short rather than pretending it is complete.
 * </p>
 */
function doorOptions(view: DoorsView | null, rows: DoorLogEntry[] | null): PickerDoor[] {
  if (view) {
    return view.doors.map(({ device }) => ({
      id: device.id, name: doorDisplayName(device), gate_key: device.gate_key,
    }));
  }
  const seen = new Map<string, PickerDoor>();
  for (const row of rows ?? []) {
    // A1: a row whose door is gone has no id to key on and no page to offer. It is named in
    // the rows and in the "Removed doors" group below, never as a live door to filter to.
    const id = row.door?.id;
    if (!id || seen.has(id)) continue;
    seen.set(id, { id, name: doorRowIdentity(row.door).label, gate_key: row.door?.gate_key ?? null });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * <b>C-H3 / R3-12 — focus stays where the person put it, across a re-render.</b>
 *
 * <p>
 * The control that caused a filter change is still on screen and still the thing they are
 * using; a re-render that leaves focus adrift is how a keyboard user ends up at the top of
 * the document after choosing a door. It restores focus only where focus has genuinely been
 * DROPPED to `<body>`, and never takes it from somewhere else — the same rule `ConfirmButton`
 * holds itself to.
 * </p>
 *
 * <p>
 * Module scope rather than the component body, because it closes over nothing: it reads the
 * live `document` and no state, no props and no hook. Being outside also makes it the obvious
 * thing to call from a second handler, which is what it is for.
 * </p>
 */
/** "Every door" / "every outcome" inside a Radix Select, which has no empty value. Never on the wire. */
const ALL = "__all__";

/** R10 L10-4: a value wraps at its spaces rather than clamp to one line — a word stays whole (Faults, L7-10). */
const WRAPPING_TRIGGER = "w-full whitespace-normal [&_[data-slot=select-value]]:line-clamp-none";

function keepFocus() {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return;
  queueMicrotask(() => {
    if (document.activeElement === document.body) active.focus();
  });
}

function AdminDoorsLogPageBody() {
  const toast = useToast();
  const now = useTicker(true);
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<DoorLogEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [retention, setRetention] = useState<number | null>(null);
  const [doors, setDoors] = useState<DoorsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [downloading, setDownloading] = useState(false);
  /**
   * A-H2 / R3-14: the export's failure, beside the button, until the next attempt.
   *
   * A toast alone was the whole of what this page said when a download failed — and a toast
   * floats, times out, and is gone by the time an admin looks for the file that was never
   * written.
   */
  const [csvFailed, setCsvFailed] = useState<string | null>(null);
  /**
   * A-C2 / R3-13: the door filter names a door the club no longer has.
   *
   * Set from the API's own `door_not_found` (WIRE-R3 §4), and inferred where an older backend
   * answers 200-and-empty instead — see {@link doorGone} below. It is not a failed read and
   * it must never render as "no scans at any door", which is a claim about the CLUB.
   */
  const [doorNotFound, setDoorNotFound] = useState(false);
  const [readAt, setReadAt] = useState<number | null>(null);
  /**
   * The filters the visible rows were actually read with.
   *
   * <p>
   * <b>Not recomputed for the CSV.</b> `from` is "now minus 24 hours", so building it twice
   * builds two different windows — and the export button's whole promise is that the file
   * has the same rows as the page. Milliseconds most of the time; a boundary scan on a busy
   * evening is a committee asking why the file and the screen disagree.
   * </p>
   */
  const [activeFilters, setActiveFilters] = useState<DoorLogFilters | null>(null);
  /**
   * The COUNT for the range, the range the server resolved, its zone, and the doors that are
   * gone — WIRE-R2 §3's four new fields, held together because they arrive together.
   *
   * <p>
   * A6: "50 scans, newest first" read as a total over a 70-row range, and that is the number
   * an admin quotes to a committee. A4: the range is the SERVER's, because a second
   * client-side "24 hours ago" is a different instant from the one the rows were read with.
   * </p>
   */
  const [page, setPage] = useState<{
    total: number | null;
    timezone: string | undefined;
    range: { from: string; to: string } | null;
    removedDoors: RemovedDoor[];
  }>({ total: null, timezone: undefined, range: null, removedDoors: [] });
  const appendedRef = useRef<HTMLLIElement>(null);
  /** C4: the node that must survive a re-render with focus on it. See the note at the control. */
  const exhaustedRef = useRef<HTMLParagraphElement>(null);
  /**
   * Which row "Load older scans" appended first — state, not a ref.
   *
   * A ref read during render is exactly what `react-hooks/refs` refuses, and it refuses it
   * for a real reason: the value a ref holds mid-render is whatever the last commit left
   * there, so the row that got the focus ref could be a row from the previous page.
   */
  const [appendedFrom, setAppendedFrom] = useState(0);
  const base = useId();

  const query = params.toString();

  const load = useCallback(async () => {
    const asked = filtersOf(new URLSearchParams(query));
    // A-L3 / R3-12: no day chosen is not a narrower question, it is no question. Asking the
    // default period here is what put a rolling window on screen under a calendar heading.
    if (awaitingDay(new URLSearchParams(query))) {
      setLoading(false);
      setFailed(false);
      setDoorNotFound(false);
      setRows([]);
      setCursor(null);
      setActiveFilters(null);
      setReadAt(Date.now());
      return;
    }
    setLoading(true);
    setOlderFailed(false);
    try {
      const read = await doorEndpoints.doorActivity(asked);
      setActiveFilters(asked);
      setDoorNotFound(false);
      setRows(read.items);
      setCursor(read.next_cursor);
      setRetention(read.retention_days);
      setPage({
        // `?? null` and never `?? items.length`: an API that sends no total leaves the page
        // saying "Showing 50 so far", which is honest. Falling back to the page length is
        // how "50 scans" came to be printed over a 70-row range in the first place.
        total: typeof read.total === "number" ? read.total : null,
        timezone: read.timezone,
        range: read.range ?? null,
        removedDoors: read.removed_doors ?? [],
      });
      setFailed(false);
      setReadAt(Date.now());
    } catch (e) {
      // A-C2 / R3-13: `door_not_found` is not a failed read and must not take the failed-read
      // sentence — "these scans could not be read" would send an admin to look for an outage
      // when the only thing wrong is a link to a board that has been replaced.
      const gone = e instanceof ApiError
        && (e.payload as { error?: string } | null | undefined)?.error === "door_not_found";
      setDoorNotFound(gone);
      setFailed(!gone);
      setRows(gone ? [] : null);
      if (gone) { setCursor(null); setReadAt(Date.now()); }
    } finally {
      setLoading(false);
    }
  }, [query]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-filter-change loader; sync loading flag is the house idiom
  useEffect(() => { void load(); }, [load]);

  // The door picker's options. Its failure costs the picker, not the page.
  useEffect(() => {
    let cancelled = false;
    doorEndpoints.doors().then((v) => { if (!cancelled) setDoors(v); }).catch(() => { /* picker shows All doors only */ });
    return () => { cancelled = true; };
  }, []);

  /**
   * <b>C4: focus the first appended row</b>, so a keyboard user is not returned to the top of
   * a list that just grew — and so the "Load older scans" button, which unmounts once the
   * range is exhausted, never drops focus to `<body>`.
   *
   * The fallback matters as much as the main case: on the LAST page there may be no new row
   * with the ref (a final page of zero), and then the exhausted notice takes the focus. It is
   * the only other node that is guaranteed to exist at that moment.
   */
  useEffect(() => {
    if (appendedRef.current) { appendedRef.current.focus(); return; }
    if (appendedFrom > 0 && !cursor) exhaustedRef.current?.focus();
  }, [rows, appendedFrom, cursor]);

  /*
   * A-M5 — a filter change is a navigation, and it PUSHES. It used to replace, so Back from a
   * narrowed log left the page entirely rather than undoing the narrowing, and Back is what
   * everybody reaches for after filtering to something that turned out to be wrong. Three taps
   * leaving three history entries is the cost, and it is the cheaper one: an extra Back press
   * is an annoyance, a Back that throws away the log you were reading is a lost place.
   */
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key); else next.set(key, value);
    keepFocus();
    setParams(next);
  };

  const loadOlder = async () => {
    // C4: guarded here rather than with `disabled`. A browser blurs a disabled element, so
    // disabling the control an admin has just activated drops focus to `<body>` — which is
    // exactly what the reviewer measured on every re-rendering button on this surface.
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    setOlderFailed(false);
    try {
      const older = await doorEndpoints.doorActivity({ ...(activeFilters ?? filtersOf(params)), cursor });
      setAppendedFrom(rows?.length ?? 0);
      setRows([...(rows ?? []), ...older.items]);
      setCursor(older.next_cursor);
      // C-L3 / R3-26: it announced nothing. Focus moves to the first appended row (C4),
      // which says where the reader is and not what happened — and on a list that grew by
      // fifty rows those are different questions. The page's own result region carries the
      // new count on the next render, so nothing extra is needed here beyond letting it.
    } catch {
      setOlderFailed(true);
    } finally {
      setLoadingOlder(false);
    }
  };

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    setCsvFailed(null);
    try {
      const { blob, filename, rows: counted, truncated } = await doorEndpoints.doorActivityCsv(activeFilters ?? filtersOf(params));
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      // B3: the SERVER's row count, never the length of the list on screen. The toast said
      // "50 scans downloaded" over a 165-row file, and that number is the one an admin
      // repeats to a committee.
      toast.push({ tone: "success", text: doorCsvDownloaded(counted, truncated), durationMs: 8000 });
    } catch (e) {
      // A-H2 / R3-14: both. The toast is what a sighted admin notices; the sentence beside
      // the button is what is still there when they look for the file.
      const said = doorCsvFailed(describeDeviceError(e, "Could not build that CSV."));
      setCsvFailed(said);
      toast.push({ tone: "danger", text: said, durationMs: 8000 });
    } finally {
      setDownloading(false);
    }
  };

  /**
   * E6 / R3-19: what the heading has to say, read off the same params the request is built
   * from so the two cannot disagree. Each is null at its default, and the generator omits
   * the clause rather than printing "all outcomes".
   */
  const outcomeLabel = (() => {
    const reason = params.get("reason");
    if (reason) return DOOR_OUTCOME_CHIPS[reason] ?? reason.replace(/_/g, " ");
    const outcome = params.get("outcome");
    if (outcome === "released") return DOOR_OUTCOME_CHIPS.ok;
    if (outcome === "refused") return "Refused";
    if (outcome === "offline") return "Offline";
    return null;
  })();
  const rangeValue = params.get("range") ?? DEFAULT_RANGE;
  const rangeLabel = rangeValue === DEFAULT_RANGE
    ? null
    : rangeValue === "day"
      ? (isClubDay(params.get("day") ?? "") ? params.get("day") : "a day not yet chosen")
      : RANGES.find((r) => r.value === rangeValue)?.label ?? null;

  const [banner1, banner2] = doorLogHowToRead();
  const doorId = params.get("door") ?? "";
  /**
   * The chosen door, by DISPLAY NAME first (A5).
   *
   * The picker labelled a door that has a display name but no slug as
   * "gate-44c103 — no door name yet", which is the board's MAC fragment where the admin's
   * own word for it was available all along. `name` is always present; `gate_key` may not be.
   */
  const chosen = doors?.doors.find((d) => d.device.id === doorId) ?? null;
  const pickerDoors = doorOptions(doors, rows);
  /**
   * The rows that ARE scans — see the note beside the count below (B1) — <b>in the order the
   * page prints them (E8 / R3-17).</b>
   *
   * <p>
   * The list says "newest first" and it was not. Lists are ordered, paged and counted on the
   * DELIVERY axis (WIRE-R1 §2), each row prints its SCAN instant (A7), and an offline row
   * delivered at 21:05 for a scan decided at 18:40 therefore sat above rows scanned at 20:00.
   * A reader checking a log after an incident reads the column of times, finds it out of
   * order, and stops trusting the page — which is the whole value of the page.
   * </p>
   *
   * <p>
   * WIRE-R3 §2 settles it: the sort key is the instant that is displayed. This side holds up
   * its end by ordering what it shows by what it prints. It is a stable sort over the rows
   * already in hand, so it re-orders only where the page would otherwise be printing an order
   * that is not the one it claims — and never invents rows or drops them.
   * </p>
   */
  const scans = (rows ?? []).filter(isDoorScan)
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => (a.entry.at === b.entry.at ? a.i - b.i : b.entry.at.localeCompare(a.entry.at)))
    .map(({ entry }) => entry);
  /**
   * Which row "Load older scans" appended first, AFTER the sort — C4's focus target.
   *
   * It used to be a position in the unsorted list, which is a different row once the list is
   * ordered by what it prints. Identity rather than index: the appended entry itself is found
   * in the sorted array.
   */
  const firstAppended = appendedFrom > 0 ? (rows ?? [])[appendedFrom] ?? null : null;
  const appendedAt = firstAppended === null ? -1 : scans.indexOf(firstAppended);
  const removedDoorKey = params.get("removed_door") ?? "";
  const chosenRemoved = page.removedDoors.find((d) => d.key === removedDoorKey) ?? null;
  const doorName = chosen ? doorDisplayName(chosen.device)
    : chosenRemoved ? removedDoorName(chosenRemoved)
      : pickerDoors.find((d) => d.id === doorId)?.name ?? null;
  const doorOnline = chosen
    ? isOnline(chosen.device, offlineAfterSecondsFor(chosen.device, null), now)
    : null;
  /**
   * <b>C5 — the ONE sentence the polite region always carries.</b>
   *
   * The count lived in a `role="status"` that only existed while there were rows, so
   * filtering the log to an EMPTY result announced nothing at all: the region was removed
   * from the document and a screen-reader user was left on a page that had silently changed
   * under them. One region, always mounted, and every one of the four outcomes writes to it.
   */
  /**
   * <b>B1, one field along.</b> The route serves scans, and this page counts what IS a scan
   * rather than trusting that — the door's own feed made exactly the opposite mistake and
   * reported "13 refused scans" over thirteen admin edits. So if this page has filtered
   * anything out of what arrived, the server's `total` counts rows this page would not show:
   * it is not a number about scans, and it is not stated. "Showing 50 so far" is the honest
   * fallback, which is also what an API that sends no total gets.
   */
  const trustedTotal = rows !== null && rows.length === scans.length ? page.total : null;
  /**
   * <b>A-C2 / R3-13, and the half that has to work against the CURRENT backend too.</b>
   *
   * <p>
   * WIRE-R3 §4 makes an unknown door a 400 `door_not_found`, which {@link load} catches. An
   * older backend answers 200 with nothing — and that is exactly the shape that printed "No
   * scans at any door in the last 24 hours". So the page also infers it: a `?door=` that no
   * read can put a name to, with the doors read LANDED (so the picker is complete) and no
   * rows, is a door that is not there. Guarded on `doors !== null` because the other reason
   * a door has no name is that the doors read failed, and that is a different sentence.
   * </p>
   */
  const doorGone = doorNotFound
    || (doorId !== "" && doors !== null && doorName === null && !loading && !failed);
  const pickADay = awaitingDay(params);
  const resultSentence = failed ? LOG_READ_FAILED
    : pickADay ? LOG_PICK_A_DAY
      : doorGone ? LOG_DOOR_GONE
        : loading ? "Reading the log…"
          // The FIRST sentence only. The rest of an empty state is a hint about what to do
          // next, which is page text; the region carries the RESULT.
          : scans.length === 0 ? emptySentence(params, doorName, doorOnline, page.range, page.timezone)[0]
            : doorLogCountLine(scans.length, trustedTotal, cursor !== null);
  /** A3: said once, where the offline rows are, rather than repeated on each of them. */
  const anyOffline = scans.some((entry) => entry.offline);

  return (
    <PageShell width="full">
      {/* E6 / R3-19: the heading is what a screenshot of this page is read as, and it said
          "All scans, all doors" over one door's refusals on one Tuesday. */}
      <PageHeader
        back={{ to: "/admin/monitoring/doors", label: "Doors" }}
        title={doorLogHeading({ doorName, outcomeLabel, rangeLabel })}
        /*
          C4: RefreshButton is `aria-disabled`, never `disabled`, while it reads. A browser
          blurs a disabled element, so disabling the control an admin has just pressed moves
          focus to `<body>` — measured on every re-rendering button on this surface. The
          handler guards the double press.
        */
        actions={<RefreshButton onRefresh={() => { if (!loading) void load(); }} loading={loading} />}
        freshness={(
          <p className="text-xs tabular-nums text-text-muted">
            {/*
              E2 / R3-3, at this call site. `clubClock` renders in whatever zone it is given
              and falls back to the BROWSER's — which is right, because a volunteer standing
              in the club is in the club's zone. What is not right is labelling it "club
              time" when the API has sent no zone: a reviewer with `Pacific/Auckland` read
              "Read at 06:09 club time" over their own clock. The words are the claim, so
              they are attached to the fact rather than printed unconditionally.
            */}
            {readAt === null ? "Reading…" : `Read at ${clubClock(readAt, page.timezone)}`}
            {readAt !== null && page.timezone ? " club time" : ""}
          </p>
        )}
      />

      {/* `min-w-0` on the grid and its columns: a grid item defaults to `min-width: auto`
          and so refuses to shrink below its content's min-content width. Same fault, same
          fix and the same measurement as the door page — see the note there. */}
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4 lg:order-1">
          {/* R10 L10-4: three columns by the filters' own BOX in rem, never `sm:` — beside the
              help panel at 200 % text a viewport rule gave each select ~140px ("Al", "La"). Under
              34rem the three stack, full width, and a value wraps at its spaces (as Faults, L7-10). */}
          <div className="@container/doorfilters">
            <fieldset className="grid gap-3 rounded-xl border border-border bg-bg-surface p-4 shadow-xs @[34rem]/doorfilters:grid-cols-3">
              <legend className="sr-only">Filter these scans</legend>
              <Field controlId={`${base}-door`}>
                <FieldLabel>Door</FieldLabel>
                <Select
                  value={(removedDoorKey ? `removed:${removedDoorKey}` : doorId) || ALL}
                  onValueChange={(picked) => {
                    const value = picked === ALL ? "" : picked;
                    const next = new URLSearchParams(params);
                    next.delete("door");
                    next.delete("removed_door");
                    // A2: a deleted board has no id, so its rows are reached by the key they
                    // stored. Never both parameters — the API answers 400 for the pair.
                    if (value.startsWith("removed:")) next.set("removed_door", value.slice("removed:".length));
                    else if (value !== "") next.set("door", value);
                    keepFocus();
                    setParams(next);
                  }}
                >
                  <SelectTrigger className={WRAPPING_TRIGGER}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All doors</SelectItem>
                    {/* A5: the DISPLAY name first, always. A6: when the doors read fails the
                        options collapse to "All doors" alone, which silently looked like a club
                        with one door — so the chosen door keeps its own option, and the picker
                        says why it is short. */}
                    {pickerDoors.map((device) => (
                      <SelectItem key={device.id} value={device.id}>{doorPickerLabel(device)}</SelectItem>
                    ))}
                    {/* A2 — the doors that are GONE. Their rows stay until the club's retention
                        rule takes them, and this group is how somebody gets to them. */}
                    {page.removedDoors.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Removed doors</SelectLabel>
                        {page.removedDoors.map((door) => (
                          <SelectItem key={door.key} value={`removed:${door.key}`}>{removedDoorName(door)}</SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
                {/* The server caps this list, and a full one is not a complete one. */}
                {removedDoorsCapNotice(page.removedDoors.length) && (
                  <FieldDescription className="text-xs">{removedDoorsCapNotice(page.removedDoors.length)}</FieldDescription>
                )}
                {doors === null && (
                  <p className="text-xs text-warning-strong">
                    The club's doors could not be read, so this list may be short. The scans below are
                    unaffected.
                  </p>
                )}
              </Field>
              <div className="flex flex-col gap-3">
                <Field controlId={`${base}-range`}>
                  <FieldLabel>When</FieldLabel>
                  <Select value={params.get("range") ?? DEFAULT_RANGE} onValueChange={(value) => setFilter("range", value)}>
                    <SelectTrigger className={WRAPPING_TRIGGER}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {RANGES.map(({ value, label }) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
                {/* A4: the sixth choice is a calendar question, so it takes a date — shown only
                    when it is the answer being given. It is the club-day DatePicker (P3, R7): a
                    picked day is always a whole club day, so the half-typed dates C-H2 / R3-12
                    had to hold back from the URL cannot be produced at all. */}
                {(params.get("range") ?? DEFAULT_RANGE) === "day" && (
                  <div className="flex flex-col gap-1.5">
                    <span aria-hidden="true" className="text-sm font-medium text-text-primary">Which day</span>
                    <DatePicker
                      label="Which day"
                      value={isClubDay(params.get("day") ?? "") ? params.get("day") : null}
                      onChange={(value) => setFilter("day", value)}
                      placeholder="Pick a day"
                    />
                    {!isClubDay(params.get("day") ?? "") && (
                      <p className="text-xs text-text-muted">Pick a day to narrow the log to it.</p>
                    )}
                  </div>
                )}
              </div>
              <Field controlId={`${base}-outcome`}>
                <FieldLabel>Outcome</FieldLabel>
                <Select
                  value={params.get("reason") ?? params.get("outcome") ?? ALL}
                  onValueChange={(picked) => {
                    const value = picked === ALL ? "" : picked;
                    const next = new URLSearchParams(params);
                    next.delete("outcome");
                    next.delete("reason");
                    if (value === "released" || value === "refused") next.set("outcome", value);
                    else if (value !== "") next.set("reason", value);
                    keepFocus();
                    setParams(next);
                  }}
                >
                  <SelectTrigger className={WRAPPING_TRIGGER}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All outcomes</SelectItem>
                    <SelectItem value="released">Lock released</SelectItem>
                    <SelectItem value="refused">Refused (any)</SelectItem>
                    {/* `ok` is deliberately absent: it is the same set of rows as "Lock
                        released" above, and two options with one label is a picker an admin
                        cannot choose between. */}
                    {Object.entries(DOOR_OUTCOME_CHIPS)
                      .filter(([reason]) => reason !== "ok")
                      .map(([reason, label]) => (
                        <SelectItem key={reason} value={reason}>{label}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </Field>
            </fieldset>
          </div>

          <p className="text-xs text-text-muted">
            This log filters by door, time and outcome. It does not filter by member: a member's own
            door history belongs to them, on their profile.
          </p>

          <div className="space-y-2">
            {/* A-C2 / R3-13: no export while the door filter names a door the club no longer
                has. The old behaviour produced a nought-row file under the ordinary
                filename, which outlives the screen that explained it. */}
            {doorGone ? (
              <p className="text-sm text-warning-strong">{LOG_CSV_BLOCKED_DOOR_GONE}</p>
            ) : pickADay ? (
              // A-L3 / R3-12, the export half: with no day chosen there is no range to
              // export, and the filters the file would be built from are the DEFAULT period
              // — so the button would hand a chair a file of the last 24 hours named for a
              // day they had not picked. That is A4's finding with a different filter.
              <p className="text-sm text-text-muted">Pick a day above before exporting.</p>
            ) : (
              <>
                {/* C4: enabled throughout, for the reason on Refresh above — `disabled` blurs. */}
                <Button
                  variant="outline"
                  onClick={() => void download()}
                  icon={<DownloadSimple aria-hidden="true" />}
                  pending={downloading}
                >
                  Download CSV
                </Button>
                {/* A-H2 / R3-14: the failure stays on the page until the next attempt. The
                    toast is still pushed — it is what a sighted admin sees first — but a
                    message that floats away is not a record of a file that was never
                    written. */}
                {csvFailed && (
                  <p role="alert" className="rounded-lg border-l-4 border-danger-strong bg-danger-soft px-3 py-2.5 text-sm text-danger-strong">
                    {csvFailed}
                  </p>
                )}
                <p className="text-xs text-text-muted">{doorCsvNotice(retention)}</p>
              </>
            )}
          </div>

          {/*
            C5 — ONE polite region, always mounted, carrying whatever this read amounts to.

            The count used to live in a `role="status"` that existed only while there were
            rows, so narrowing the log to an EMPTY result announced nothing at all: the region
            was removed from the document and a screen-reader user was left on a page that had
            silently changed under them. All four outcomes — reading, failed, empty, counted —
            write here, and nothing else on this page carries a live role.

            C15: it holds only the RESULT. The permanent explanations (how to read the log, the
            retention rule, what the CSV carries) are plain text elsewhere — a standing
            paragraph inside a live region is announced as an update on every visit.
          */}
          <p
            role="status"
            className={failed
              ? "rounded-lg border-l-4 border-danger-strong bg-danger-soft px-3 py-2.5 text-sm text-danger-strong"
              : "text-sm text-text-secondary"}
          >
            {resultSentence}
          </p>

          {/* A4: the range the SERVER resolved, in words, above the rows. "Last 24 hours" is
              rolling, and a chair exporting "yesterday" was handed half of yesterday and half
              of today with nothing on the page saying so. */}
          {!failed && clubRangeInWords(page.range, page.timezone) && (
            <p className="text-xs text-text-muted">{clubRangeInWords(page.range, page.timezone)}</p>
          )}

          {failed ? (
            <Button variant="outline" onClick={() => void load()}>Try again</Button>
          ) : pickADay ? (
            // A-L3 / R3-12: the rows are deliberately absent. Listing the default period
            // here is what put a rolling window under a calendar heading.
            <p className="text-sm text-text-secondary">Choose a day above.</p>
          ) : doorGone ? (
            <div className="space-y-2">
              <p className="text-sm text-text-secondary">{LOG_DOOR_GONE_HINT}</p>
              <Button
                variant="outline"
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.delete("door");
                  setParams(next);
                }}
              >
                Show all doors
              </Button>
            </div>
          ) : loading ? null : scans.length === 0 ? (
            <div className="space-y-2">
              {/* The FIRST sentence is in the region above — printing it twice is how the
                  reviewer's screen reader heard the empty state and the sighted reader read
                  it two inches apart. Only what the region did not carry is repeated here. */}
              {emptySentence(params, doorName, doorOnline, page.range, page.timezone).slice(1).map((sentence) => (
                <p key={sentence} className="text-sm text-text-secondary">{sentence}</p>
              ))}
              {doorName && !chosenRemoved && (
                <TextLink variant="standalone" to="/admin/monitoring/doors" className="text-sm">
                  Check it on Doors
                </TextLink>
              )}
            </div>
          ) : (
            <>
              {/* A3: said once, beside the offline rows, rather than left to be inferred from
                  nine rows where some name a member and some do not. */}
              {anyOffline && <p className="text-xs text-text-muted">{OFFLINE_WHO_NOTE}</p>}
              <Card>
                <ul>
                  {scans.map((entry, i) => (
                    <DoorFeedRow
                      key={`${entry.at}-${entry.action}-${i}`}
                      entry={entry}
                      now={now}
                      // B17 / A5: the door's DISPLAY name, which is what an admin calls it.
                      // This printed the slug, so a log read after an incident named every
                      // row "front-door" where the club says "Front door".
                      // A1: and it is `doorRowName` rather than `.name`, because a row whose
                      // board has been deleted carries nulls — reading `.name` off that is
                      // the blank white page three reviewers found.
                      doorName={doorRowName(entry.door)}
                      // A7 / O1: the CLUB's zone, from this read. One formatter on this
                      // surface, always given a zone where the API supplies one.
                      timezone={page.timezone}
                      innerRef={i > 0 && i === appendedAt ? appendedRef : undefined}
                    />
                  ))}
                </ul>
              </Card>
              {olderFailed && <Alert tone="danger">{`${LOG_OLDER_FAILED} The ${scans.length} above are still correct.`}</Alert>}
              {cursor ? (
                <Button variant="outline" block onClick={() => void loadOlder()} pending={loadingOlder}>
                  {olderFailed ? "Try again" : "Load older scans"}
                </Button>

              ) : (
                // C4: `tabIndex={-1}` so that on the LAST page — where the button above
                // unmounts — focus has somewhere to land other than `<body>`. See the effect.
                <p ref={exhaustedRef} tabIndex={-1} className="text-sm text-text-muted">
                  {doorExhaustedNotice(retention)}
                </p>
              )}
            </>
          )}
        </div>

        {/* Never dismissible. Dismissing it is how it stops being true for the next reader, who
            is usually somebody reading a log after an incident. */}
        <aside aria-labelledby="how-to-read" className="min-w-0 lg:order-2">
          <Card className="space-y-3">
            <h2 id="how-to-read" className="text-base font-semibold">How to read this log</h2>
            <p className="text-sm text-text-secondary">{banner1}</p>
            <p className="text-sm text-text-secondary">{banner2}</p>
            <p className="text-sm text-text-secondary">{doorRetentionNotice(retention)}</p>
          </Card>
        </aside>
      </div>
    </PageShell>
  );
}

/**
 * A1 / E-C1 / C1: THE page the critical was found on. Exported through the doors error
 * boundary, so a rendering fault shows a heading, a sentence and a way back instead of the
 * blank white document a deleted door produced for the whole club.
 */
export const AdminDoorsLogPage = withDoorsBoundary(AdminDoorsLogPageBody);
