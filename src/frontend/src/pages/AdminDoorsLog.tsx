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
  LOG_READ_FAILED, doorCsvNotice, doorExhaustedNotice, doorLogEmptyOneDoor, doorLogHowToRead,
  doorRetentionNotice,
} from "../lib/doorsCopy";
import { DOOR_OUTCOME_CHIPS } from "../lib/deviceActivity";
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

/** Which empty sentence is true here — narrowed, one door, or genuinely nothing. */
function emptySentence(params: URLSearchParams, doorName: string | null): string[] {
  if (doorName) {
    const from = fromFor(params.get("range") ?? "24h");
    const face = new Date(from).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
    return [doorLogEmptyOneDoor(doorName, face)];
  }
  const narrowed = (params.get("outcome") ?? "") !== "" || (params.get("reason") ?? "") !== ""
    || (params.get("range") ?? "24h") !== "24h";
  if (narrowed) return [LOG_EMPTY_FILTERED, LOG_EMPTY_FILTERED_HINT];
  return [LOG_EMPTY_NOTHING];
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
  const appendedFrom = useRef(0);
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
      appendedFrom.current = rows?.length ?? 0;
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
      const { blob, filename } = await doorEndpoints.doorActivityCsv(activeFilters ?? filtersOf(params));
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      toast.push({ tone: "success", text: `${rows?.length ?? 0} scans downloaded.` });
    } catch (e) {
      toast.push({ tone: "danger", text: describeDeviceError(e, "Could not build that CSV.") });
    } finally {
      setDownloading(false);
    }
  };

  const [banner1, banner2] = doorLogHowToRead();
  const doorId = params.get("door") ?? "";
  const doorName = doors?.doors.find((d) => d.device.id === doorId)?.device.name ?? null;

  return (
    <div className="space-y-6">
      <header className="space-y-2 sm:flex sm:items-start sm:justify-between sm:gap-4 sm:space-y-0">
        <div>
          <Link to="/admin/doors" className="inline-flex min-h-11 items-center text-sm text-accent-strong">← Doors</Link>
          <h1 className="text-2xl font-bold tracking-tight">All scans, all doors</h1>
          <p className="text-xs text-text-muted">
            {readAt === null ? "Reading…" : `Read at ${new Date(readAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}`}
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          {loading ? "Reading…" : "Refresh"}
        </Button>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4 lg:order-1">
          <fieldset className="grid gap-3 sm:grid-cols-3">
            <legend className="sr-only">Filter these scans</legend>
            <div>
              <Label htmlFor={`${base}-door`}>Door</Label>
              <Select id={`${base}-door`} value={doorId} onChange={(e) => setFilter("door", e.target.value)}>
                <option value="">All doors</option>
                {doors?.doors.map(({ device }) => (
                  <option key={device.id} value={device.id}>
                    {device.gate_key ? `${device.name} (${device.gate_key})` : `${device.device_code} — ${UNNAMED_GATE}`}
                  </option>
                ))}
              </Select>
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
          ) : (rows?.length ?? 0) === 0 ? (
            <div className="space-y-2">
              {emptySentence(params, doorName).map((sentence) => (
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
              <p role="status" className="text-sm text-text-secondary">
                {`${rows!.length} ${rows!.length === 1 ? "scan" : "scans"}, newest first`}
              </p>
              <Card>
                <ul>
                  {rows!.map((entry, i) => (
                    <DoorFeedRow
                      key={`${entry.at}-${entry.action}-${i}`}
                      entry={entry}
                      now={now}
                      doorName={entry.door.gate_key ?? entry.door.name}
                      innerRef={i > 0 && i === appendedFrom.current ? appendedRef : undefined}
                    />
                  ))}
                </ul>
              </Card>
              {olderFailed && <Alert tone="danger">{`${LOG_OLDER_FAILED} The ${rows!.length} above are still correct.`}</Alert>}
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
        <aside aria-labelledby="how-to-read" className="lg:order-2">
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
