import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Card } from "../components/Card";
import { Alert } from "../components/Alert";
import { Button, Label, Select } from "../components/Button";
import { useToast } from "../components/Toast";
import { DoorFeedRow } from "../components/doors/DoorFeedRow";
import { useTicker } from "../lib/useTicker";
import {
  LOG_EMPTY_FILTERED, LOG_EMPTY_FILTERED_HINT, LOG_EMPTY_NOTHING, LOG_OLDER_FAILED,
  LOG_READ_FAILED, doorCsvDownloaded, doorCsvNotice, doorExhaustedNotice, doorLogEmptyOneDoor,
  doorLogHowToRead, doorRetentionNotice,
} from "../lib/doorsCopy";
import { clubClock, clubDayAndClock } from "../lib/clubClock";
import { isOnline, offlineAfterSecondsFor } from "../lib/deviceLiveness";
import { DOOR_OUTCOME_CHIPS, isDoorScan } from "../lib/deviceActivity";
import { UNNAMED_GATE } from "../lib/gateCopy";
import { describeDeviceError } from "../lib/deviceErrors";
import {
  doorEndpoints, type DoorLogEntry, type DoorLogFilters, type DoorsView,
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

const RANGES: Record<string, { label: string; hours: number | null }> = {
  "24h": { label: "Last 24 hours", hours: 24 },
  "7d": { label: "Last 7 days", hours: 24 * 7 },
  "30d": { label: "Last 30 days", hours: 24 * 30 },
};

function fromFor(range: string): string {
  const hours = RANGES[range]?.hours ?? 24;
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

/** The filters as the request carries them — one source for the list AND the CSV. */
function filtersOf(params: URLSearchParams): DoorLogFilters {
  const door = params.get("door") ?? undefined;
  const outcome = (params.get("outcome") ?? undefined) as DoorLogFilters["outcome"];
  const reason = params.get("reason") ?? undefined;
  return { door, outcome, reason, from: fromFor(params.get("range") ?? "24h") };
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
): string[] {
  if (doorName) {
    // B20: the boundary carries its date. "Fri 18:40" against a 30-day range names four
    // Fridays and the reader cannot tell which one the filter starts at.
    const face = clubDayAndClock(fromFor(params.get("range") ?? "24h"));
    return [doorLogEmptyOneDoor(doorName, face, online)];
  }
  const narrowed = (params.get("outcome") ?? "") !== "" || (params.get("reason") ?? "") !== ""
    || (params.get("range") ?? "24h") !== "24h";
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
  if (view) return view.doors.map(({ device }) => ({ id: device.id, name: device.name, gate_key: device.gate_key }));
  const seen = new Map<string, PickerDoor>();
  for (const row of rows ?? []) {
    if (!seen.has(row.door.id)) seen.set(row.door.id, row.door);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function AdminDoorsLogPage() {
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
  const appendedRef = useRef<HTMLLIElement>(null);
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
    setLoading(true);
    setOlderFailed(false);
    try {
      const asked = filtersOf(new URLSearchParams(query));
      const page = await doorEndpoints.doorActivity(asked);
      setActiveFilters(asked);
      setRows(page.items);
      setCursor(page.next_cursor);
      setRetention(page.retention_days);
      setFailed(false);
      setReadAt(Date.now());
    } catch {
      setFailed(true);
      setRows(null);
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

  /** Focus the first appended row, so a keyboard user is not returned to the top of a list that grew. */
  useEffect(() => { appendedRef.current?.focus(); }, [rows]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key); else next.set(key, value);
    // `replace`, so three taps on a phone do not leave three history entries between the
    // admin and the page they came from.
    setParams(next, { replace: true });
  };

  const loadOlder = async () => {
    if (!cursor) return;
    setLoadingOlder(true);
    setOlderFailed(false);
    try {
      const page = await doorEndpoints.doorActivity({ ...(activeFilters ?? filtersOf(params)), cursor });
      setAppendedFrom(rows?.length ?? 0);
      setRows([...(rows ?? []), ...page.items]);
      setCursor(page.next_cursor);
    } catch {
      setOlderFailed(true);
    } finally {
      setLoadingOlder(false);
    }
  };

  const download = async () => {
    setDownloading(true);
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
      toast.push({ tone: "danger", text: describeDeviceError(e, "Could not build that CSV.") });
    } finally {
      setDownloading(false);
    }
  };

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
  /** The rows that ARE scans — see the note beside the count below (B1). */
  const scans = (rows ?? []).filter(isDoorScan);
  const doorName = chosen?.device.name ?? pickerDoors.find((d) => d.id === doorId)?.name ?? null;
  const doorOnline = chosen
    ? isOnline(chosen.device, offlineAfterSecondsFor(chosen.device, null), now)
    : null;

  return (
    <div className="space-y-6">
      <header className="space-y-2 sm:flex sm:items-start sm:justify-between sm:gap-4 sm:space-y-0">
        <div>
          <Link to="/admin/doors" className="inline-flex min-h-11 items-center text-sm text-accent-strong">← Doors</Link>
          <h1 className="text-2xl font-bold tracking-tight">All scans, all doors</h1>
          <p className="text-xs text-text-muted">
            {readAt === null ? "Reading…" : `Read at ${clubClock(readAt)}`}
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          {loading ? "Reading…" : "Refresh"}
        </Button>
      </header>

      {/* `min-w-0` on the grid and its columns: a grid item defaults to `min-width: auto`
          and so refuses to shrink below its content's min-content width. Same fault, same
          fix and the same measurement as the door page — see the note there. */}
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4 lg:order-1">
          <fieldset className="grid gap-3 sm:grid-cols-3">
            <legend className="sr-only">Filter these scans</legend>
            <div>
              <Label htmlFor={`${base}-door`}>Door</Label>
              <Select id={`${base}-door`} value={doorId} onChange={(e) => setFilter("door", e.target.value)}>
                <option value="">All doors</option>
                {/* A5: the DISPLAY name first, always. A door with a name and no slug was
                    labelled "gate-44c103 — no door name yet", which is a MAC fragment where
                    the admin's own word for it was sitting in `name` the whole time.
                    A6: when the doors read fails the options collapse to "All doors" alone,
                    which silently looked like a club with one door — so the chosen door keeps
                    its own option, and the picker says why it is short. */}
                {pickerDoors.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.gate_key ? `${device.name} (${device.gate_key})` : `${device.name} — ${UNNAMED_GATE}`}
                  </option>
                ))}
              </Select>
              {doors === null && (
                <p className="mt-1 text-xs text-warning-strong">
                  The club's doors could not be read, so this list may be short. The scans below are
                  unaffected.
                </p>
              )}
            </div>
            <div>
              <Label htmlFor={`${base}-range`}>When</Label>
              <Select id={`${base}-range`} value={params.get("range") ?? "24h"} onChange={(e) => setFilter("range", e.target.value)}>
                {Object.entries(RANGES).map(([key, { label }]) => <option key={key} value={key}>{label}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor={`${base}-outcome`}>Outcome</Label>
              <Select
                id={`${base}-outcome`}
                value={params.get("reason") ?? params.get("outcome") ?? ""}
                onChange={(e) => {
                  const value = e.target.value;
                  const next = new URLSearchParams(params);
                  next.delete("outcome");
                  next.delete("reason");
                  if (value === "released" || value === "refused") next.set("outcome", value);
                  else if (value !== "") next.set("reason", value);
                  setParams(next, { replace: true });
                }}
              >
                <option value="">All outcomes</option>
                <option value="released">Lock released</option>
                <option value="refused">Refused (any)</option>
                {/* `ok` is deliberately absent: it is the same set of rows as "Lock
                    released" above, and two options with one label is a picker an admin
                    cannot choose between. */}
                {Object.entries(DOOR_OUTCOME_CHIPS)
                  .filter(([reason]) => reason !== "ok")
                  .map(([reason, label]) => (
                    <option key={reason} value={reason}>{label}</option>
                  ))}
              </Select>
            </div>
          </fieldset>

          <p className="text-xs text-text-muted">
            This log filters by door, time and outcome. It does not filter by member: a member's own
            door history belongs to them, on their profile.
          </p>

          <div className="space-y-2">
            <Button variant="outline" onClick={() => void download()} disabled={downloading || loading} aria-busy={downloading}>
              {downloading ? "Preparing…" : "Download CSV"}
            </Button>
            <p className="text-xs text-text-muted">{doorCsvNotice(retention)}</p>
          </div>

          {failed ? (
            <div className="space-y-3">
              <Alert tone="danger">{LOG_READ_FAILED}</Alert>
              <Button variant="outline" onClick={() => void load()}>Try again</Button>
            </div>
          ) : loading ? (
            <p className="text-sm text-text-secondary">Loading the club's door scans…</p>
          ) : scans.length === 0 ? (
            <div className="space-y-2">
              {emptySentence(params, doorName, doorOnline).map((sentence) => (
                <p key={sentence} className="text-sm text-text-secondary">{sentence}</p>
              ))}
              {doorName && (
                <Link to="/admin/doors" className="inline-flex min-h-11 items-center text-sm text-accent-strong">
                  Check it on Doors
                </Link>
              )}
            </div>
          ) : (
            <>
              {/*
                B1's "four views of ONE set", held on this side too.

                The server already narrows this route to scans — it is why the reviewer's
                club log showed no rows for a door whose own page claimed thirteen refusals.
                But the count here is a CLAIM an admin quotes, and the door's own feed made
                exactly this mistake by counting whatever arrived. Counting what is actually
                a scan costs one filter and cannot be wrong; trusting the route is a promise
                about somebody else's code.
              */}
              <p role="status" className="text-sm text-text-secondary">
                {`${scans.length} ${scans.length === 1 ? "scan" : "scans"}, newest first`}
              </p>
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
                      doorName={entry.door.name}
                      innerRef={i > 0 && i === appendedFrom ? appendedRef : undefined}
                    />
                  ))}
                </ul>
              </Card>
              {olderFailed && <Alert tone="danger">{`${LOG_OLDER_FAILED} The ${scans.length} above are still correct.`}</Alert>}
              {cursor ? (
                <Button variant="outline" className="w-full" onClick={() => void loadOlder()} disabled={loadingOlder}>
                  {olderFailed ? "Try again" : loadingOlder ? "Loading…" : "Load older scans"}
                </Button>
              ) : (
                <p className="text-sm text-text-muted">{doorExhaustedNotice(retention)}</p>
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
    </div>
  );
}
