import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Alert } from "@/components/Alert";
import { useToast } from "@/components/toastContext";
import { FilterBar, FilterSelect, CardListSkeleton, type FilterOption } from "@/components/monitoring/parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Door, DownloadSimple, WifiSlash } from "@/components/ui/icons";
import { Section } from "@/components/ui/page-shell";
import { StateBlock } from "@/components/ui/state-block";
import { doorEndpoints } from "@/lib/api";
import { clubRangeInWords, clubRowTime } from "@/lib/clubClock";
import { describeFailure } from "@/lib/errors";
import {
  memberDetailEndpoints, saveFile, type MemberDoorFilters, type MemberDoorRow, type MemberDoorsPage,
} from "@/lib/memberDetailApi";
import { DEFAULT_DOOR_PERIOD, DOOR_PERIODS, DOORS_TAB_COPY as COPY, doorMethod } from "@/lib/memberDetailCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { usePagedFocus } from "@/lib/usePagedFocus";
import { useRead } from "@/lib/useRead";
import { useTicker } from "@/lib/useTicker";
import { cn } from "@/lib/utils";
import { doorDisplayName } from "@/lib/doorsCopy";
import { doorOptions } from "./doorOptions";
import { useMemberDetail } from "./useMemberDetail";

/**
 * Door history — D9: an admin may read one member's door scans. This REVERSES the doors
 * contract's privacy rule P3 (the club log carries no per-member filter anywhere), deliberately
 * and loudly: the member is a path segment, never a query parameter a future change could make
 * optional; every successful read writes a change-record line naming who looked and at whom; and
 * the page says so before anything is read, and says nothing was recorded when a read fails.
 *
 * <p>
 * <b>The filters are the club log's grammar</b> — period, door, outcome — and live in the URL, so
 * a link to "Thandi's refused scans last week" is a link. A read is audited, so changing a filter
 * is a deliberate act that re-reads once; nothing here polls.
 * </p>
 */
export function MemberDoors() {
  const { userId } = useMemberDetail();
  const [params, setParams] = useSearchParams();
  const filters: MemberDoorFilters = {
    period: params.get("period") || DEFAULT_DOOR_PERIOD,
    door: params.get("door") ?? "",
    outcome: (params.get("outcome") ?? "") as MemberDoorFilters["outcome"],
  };
  const pages = useDoorPages(userId, filters);
  const doors = useDoorOptions();
  const download = useDownload(userId, filters);

  const setFilter = (key: "period" | "door" | "outcome", value: string) => {
    setParams((prev) => {
      const out = new URLSearchParams(prev);
      if (value && !(key === "period" && value === DEFAULT_DOOR_PERIOD)) out.set(key, value); else out.delete(key);
      return out;
    }, { replace: true });
  };

  return (
    <Section title={COPY.title}>
      {/* Standing, said once: a fact about the screen, re-rendered on every read. */}
      <Alert tone="info" live="standing" announceKey="member-doors-audited">{COPY.audited}</Alert>
      <FilterBar>
        <FilterSelect id="member-doors-period" label={COPY.period} value={filters.period ?? ""} options={DOOR_PERIODS} onChange={(v) => setFilter("period", v)} />
        <FilterSelect id="member-doors-door" label={COPY.door} value={filters.door ?? ""} options={doors} onChange={(v) => setFilter("door", v)} />
        <FilterSelect
          id="member-doors-outcome"
          label={COPY.outcome}
          value={filters.outcome ?? ""}
          options={[
            { value: "", label: COPY.anyOutcome },
            { value: "released", label: COPY.released },
            { value: "refused", label: COPY.refused },
            { value: "offline", label: COPY.offline },
          ]}
          onChange={(v) => setFilter("outcome", v)}
        />
        <Button
          variant="outline"
          // R8 L8-6: wraps rather than push a 320 phone sideways at 200 % text.
          className="max-w-full whitespace-normal sm:ml-auto"
          onClick={() => void download.run()}
          pending={download.pending}
          icon={<DownloadSimple aria-hidden="true" />}
        >
          {COPY.download}
        </Button>
      </FilterBar>
      <DoorPagesView pages={pages} />
    </Section>
  );
}

/* ─────────────────────────────── the list ─────────────────────────────── */

type Pages = ReturnType<typeof useDoorPages>;

function DoorPagesView({ pages }: { pages: Pages }) {
  const { first } = pages;
  // Which rows are "today" moves with the clock; a minute is finer than anybody reads it.
  const now = useTicker(true, 60_000);
  // R12 X12-2 — the last page takes "Load older" away; the first scan it brought takes focus.
  const loadOlder = usePagedFocus("[data-member-doors] > li", pages.more.run);
  return (
    <StateBlock
      loading={pages.loading}
      error={pages.error}
      action={COPY.loadAction}
      // The server writes its audit row on a 200. A failed read that still claimed "viewing
      // this is recorded" would make the notice above a lie about the only thing it promises.
      failedCaveat={COPY.failedCaveat}
      onRetry={pages.retry}
      empty={!pages.loading && !pages.error && pages.items.length === 0}
      emptyIcon={Door}
      emptyTitle={COPY.empty}
      emptyHint={COPY.emptyHint}
      skeleton={<CardListSkeleton rows={4} />}
    >
      {first ? (
        <p className="text-sm text-text-secondary">
          {[clubRangeInWords(first.range, first.timezone), COPY.total(pages.items.length, first.total)].filter(Boolean).join(" ")}
        </p>
      ) : null}
      {/* R15 L15-3: the time beside the scan where the LIST's box has room (rem, so 200 % text
          counts), its column as wide as the widest time on the page (auto, rows on a subgrid). */}
      <div className="[container-type:inline-size]">
        <ol data-member-doors="" className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-bg-surface [&_:focus-visible]:-outline-offset-2 [@container(min-width:30rem)]:grid [@container(min-width:30rem)]:grid-cols-[auto_minmax(0,1fr)_auto]">
          {pages.items.map((row, i) => (
            <DoorLine key={`${row.at}-${i}`} row={row} now={now} timezone={first?.timezone} />
          ))}
        </ol>
      </div>
      {pages.more.error ? <Alert tone="danger">{COPY.loadOlderFailed}</Alert> : null}
      {pages.cursor ? (
        <div className="flex justify-center">
          <Button variant="outline" pending={pages.more.pending} onClick={loadOlder}>{COPY.loadOlder}</Button>
        </div>
      ) : null}
      {first ? <p className="text-xs text-text-muted">{COPY.retention(first.retention_days)}</p> : null}
    </StateBlock>
  );
}

/**
 * What the club log calls the door (E6-9): its own name, or "Unnamed scanner (gate-44c103)" —
 * never the "Door gate" placeholder a gate registers under, which is not a name (doorsCopy A11).
 */
function doorName(row: MemberDoorRow): string {
  const { name: given, gate_key: key } = row.door;
  // R8 (E7-4 rest): the board's own code is what the Doors page and the Night name an unnamed
  // gate by; `gate_key` only for a row older than `device_code` on the wire.
  const code = row.door.device_code ?? key;
  const name = given === null && code === null ? COPY.unknownDoor : doorDisplayName({ name: given, device_code: code });
  return row.door.removed ? `${name} ${COPY.removedDoor}` : name;
}

/**
 * One scan. The time first (the question a committee asks is "what time"), then the door, the
 * outcome as a word AND a tone, the server's own reason sentence, and how they identified.
 */
function DoorLine({ row, now, timezone }: { row: MemberDoorRow; now: number; timezone?: string }) {
  const released = row.outcome === "released";
  const method = doorMethod(row.method);
  return (
    // tabIndex −1: where "Load older" hands focus when its last page takes the button away (X12-2).
    <li tabIndex={-1} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 px-4 py-3 [@container(min-width:30rem)]:col-span-3 [@container(min-width:30rem)]:grid-cols-subgrid">
      <time
        dateTime={row.at}
        title={row.time_uncertain ? COPY.approximate : undefined}
        className="text-sm font-medium tabular-nums text-text-secondary [@container(min-width:30rem)]:pt-0.5"
      >
        {`${row.time_uncertain ? "≈" : ""}${clubRowTime(row.at, now, timezone)}`}
        {row.time_uncertain ? <span className="sr-only">{` — ${COPY.approximate}`}</span> : null}
      </time>
      <div className="col-span-2 row-start-2 flex min-w-0 flex-col gap-0.5 [@container(min-width:30rem)]:col-span-1 [@container(min-width:30rem)]:col-start-2 [@container(min-width:30rem)]:row-start-1">
        <p className="break-words font-semibold text-text-primary">{doorName(row)}</p>
        <p className="break-words text-sm text-text-secondary">{row.reason_text}</p>
        {row.offline || method ? (
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
            {method ? <span>{method}</span> : null}
            {row.offline ? (
              <span className="inline-flex items-center gap-1">
                <WifiSlash size={14} weight="bold" aria-hidden="true" />
                {COPY.offlineNote}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
      <Badge tone={released ? "success" : "danger"} className={cn("col-start-2 row-start-1 justify-self-end [@container(min-width:30rem)]:col-start-3")}>
        {released ? COPY.released : COPY.refused}
      </Badge>
    </li>
  );
}

/* ─────────────────────────────── the reads ─────────────────────────────── */

type Extra = { base: MemberDoorsPage | null; items: MemberDoorRow[]; cursor: string | null };

/** First page keyed on the filters; older pages appended to THAT first page only. */
function useDoorPages(userId: string, filters: MemberDoorFilters) {
  const { period, door, outcome } = filters;
  const load = useCallback(
    () => memberDetailEndpoints.doors(userId, { period, door, outcome }),
    [userId, period, door, outcome],
  );
  const [read, retry] = useRead(`${userId}:${period}:${door}:${outcome}`, load);
  const [extra, setExtra] = useState<Extra>({ base: null, items: [], cursor: null });
  const base = read.data;
  const follows = base !== null && extra.base === base;
  const cursor = follows ? extra.cursor : base?.next_cursor ?? null;

  const more = useAsyncAction(async () => {
    if (!base || !cursor) return;
    const page = await memberDetailEndpoints.doors(userId, { period, door, outcome, cursor });
    setExtra((prev) => ({ base, items: [...(prev.base === base ? prev.items : []), ...page.items], cursor: page.next_cursor }));
  });

  return {
    first: base,
    items: [...(base?.items ?? []), ...(follows ? extra.items : [])],
    cursor,
    loading: read.loading,
    error: read.error,
    retry,
    more,
  };
}

/**
 * The door filter's options: the club's doors, by name. Best effort — if the doors cannot be
 * read the filter still offers "Any door", which is true, rather than an empty list, which would
 * say the club has no doors.
 */
function useDoorOptions(): FilterOption[] {
  const [read] = useRead("doors", doorEndpoints.doors);
  return doorOptions(read.data?.doors ?? []);
}


function useDownload(userId: string, filters: MemberDoorFilters) {
  const toast = useToast();
  return useAsyncAction(
    async () => saveFile(await memberDetailEndpoints.doorsCsv(userId, filters)),
    {
      success: () => toast.push({ tone: "success", text: COPY.downloaded }),
      failure: (error) => toast.push({ tone: "danger", text: describeFailure(error, { action: COPY.downloadAction }), durationMs: 8000 }),
    },
  );
}
