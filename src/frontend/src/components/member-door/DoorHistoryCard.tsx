import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../ui/card";
import { RefreshButton } from "../ui/refresh-button";
import { Skeleton } from "../ui/skeleton";
import { Info, WarningCircle } from "../ui/icons";
import { endpoints, type MemberDoorHistoryRow } from "../../lib/api";
import { clubClock, clubDayAndClock } from "../../lib/clubClock";
import { usePagedFocus } from "../../lib/usePagedFocus";
import {
  CLUB_TIME_NOTE,
  HISTORY_ANCHOR,
  HISTORY_DELIVERY_ORDER,
  HISTORY_EMPTY,
  HISTORY_FAILED,
  HISTORY_INTRO,
  HISTORY_LOADING,
  HISTORY_MORE_FAILED,
  HISTORY_P2_NOTICE,
  HISTORY_REFRESH,
  HISTORY_RETRY,
  HISTORY_SHOW_MORE,
  HISTORY_TITLE,
  TIME_UNCERTAIN_NOTE,
  UNNAMED_DOOR,
  historyAsOf,
  historyChip,
  historyGroupLabel,
  historyLine,
  historyRetention,
  timeIsUncertain,
} from "../../lib/memberDoorCopy";

/**
 * "My door history" — the member's own rows, and nobody else's.
 *
 * <p>
 * This is the POPIA s.23 right served as a product feature, on the page a member already
 * thinks of as their record. It is the counterweight to the admin door log, which filters
 * by door, time and outcome and has no per-member filter anywhere in it: the club's log
 * is about doors, and a member's own history belongs to the member.
 * </p>
 *
 * <p>
 * <b>What it may never become.</b> No filter, no search, no export, no count, no streak.
 * The moment this card totals anything it has become entry statistics, and a door scan is
 * never attendance. No `DataTable` either — that primitive is built for the admin console
 * at `max-w-7xl`, and a four-column table inside this page's `max-w-xl` at 360 px is a
 * horizontal scroll for no gain.
 * </p>
 *
 * <p>
 * <b>Three states, three different sentences.</b> A list initialised to `[]` renders its
 * empty state on a FAILED read, and the member concludes nothing has ever been recorded
 * about them. That is the defect these two sentences exist to make impossible, and they
 * are asserted to differ.
 * </p>
 *
 * <p>
 * <b>It reads on its own and is gated on nothing else. D11.</b> The Profile page used to
 * drop this card whenever `/me/door` failed, which deleted a member's record from their own
 * page over a request that had nothing to do with it. This card's rows come from
 * `/me/door/history`, so that is the read it is allowed to depend on.
 * </p>
 */

type Phase = "loading" | "ready" | "failed";

/**
 * Adjacent rows that are identical in every VISIBLE field, collapsed into one. R3-31.
 *
 * <p>
 * <b>The member's own record showed six rows the same.</b> Same door, same minute, same
 * outcome, same sentence — because a code held against a scanner fires repeatedly and every
 * attempt is a row. Six copies of one line is a record nobody reads, and a member counting
 * them concludes six separate things happened to them.
 * </p>
 *
 * <p>
 * <b>The grouping key is what the ROW DRAWS, not what the row is.</b> Two rows a minute
 * apart that render the same clock face are indistinguishable on screen and are what the
 * finding is about; two rows that differ in any drawn field are two rows and stay two,
 * however close together. Building the key from the rendered strings is what keeps that
 * true when a field is added to the row, rather than a second list of fields to remember to
 * extend.
 * </p>
 *
 * <p>
 * Only ADJACENT rows collapse. The list is ordered on the delivery axis and a group that
 * reached across an unrelated row in between would be the card reordering a member's own
 * record to make it tidier.
 * </p>
 */
type HistoryGroup = {
  row: MemberDoorHistoryRow;
  /** How many rows this one stands for, including itself. 1 for an ordinary row. */
  count: number;
  /** Seconds between the first and last of them, for the marker. */
  spanSeconds: number;
};

function drawnKey(row: MemberDoorHistoryRow, timezone: string | undefined): string {
  return [
    clubDayAndClock(row.at, timezone),
    row.door_name ?? UNNAMED_DOOR,
    historyChip(row).label,
    historyLine(row, timezone) ?? "",
    timeIsUncertain(row) ? "approx" : "",
    // A separator no rendered string can contain, so two rows cannot be made to look
    // identical by a door name that happens to end where a chip label begins.
  ].join("\u0000");
}

function groupHistoryRows(
  rows: MemberDoorHistoryRow[], timezone: string | undefined,
): HistoryGroup[] {
  const out: HistoryGroup[] = [];
  let key: string | null = null;
  let firstAt = 0;
  for (const row of rows) {
    const next = drawnKey(row, timezone);
    const at = Date.parse(row.at);
    const last = out[out.length - 1];
    if (last && next === key) {
      last.count += 1;
      // Both ends, because the rows are in delivery order and their own instants are not
      // guaranteed to be — an offline burst arrives newest-delivered first.
      const span = Number.isNaN(at) || Number.isNaN(firstAt) ? 0 : Math.abs(firstAt - at) / 1000;
      last.spanSeconds = Math.max(last.spanSeconds, span);
      continue;
    }
    key = next;
    firstAt = at;
    out.push({ row, count: 1, spanSeconds: 0 });
  }
  return out;
}

function HistoryRow({ group, timezone }: { group: HistoryGroup; timezone: string | undefined }) {
  const { row, count, spanSeconds } = group;
  const chip = historyChip(row);
  const line = historyLine(row, timezone);
  // R3-17. The server flags a clamped clock; the page can also see an impossible order for
  // itself. Either way the member is told the minute is approximate rather than left to
  // reconcile two numbers that cannot both be right.
  const uncertain = timeIsUncertain(row);
  return (
    <li data-door-history-row="" className="flex flex-col gap-1 py-3 md:grid md:grid-cols-[auto_1fr_auto] md:items-baseline md:gap-x-4">
      {/* The club's day, not the viewer's. O1 — and stated once under the list, not here. */}
      <p className="text-sm font-medium tabular-nums text-text-primary">
        {uncertain && <span aria-hidden="true">~</span>}
        {clubDayAndClock(row.at, timezone)}
        {/* R3-31 — a de-duplication marker, never a total. See `historyGroupLabel`. */}
        {count > 1 && <span className="ml-1.5 font-normal text-text-muted">{historyGroupLabel(count, spanSeconds)}</span>}
      </p>
      <div className="flex items-center justify-between gap-2 md:contents">
        <p className="text-sm text-text-secondary">{row.door_name ?? UNNAMED_DOOR}</p>
        <Badge tone={chip.tone === "muted" ? "neutral" : chip.tone} className="shrink-0">{chip.label}</Badge>
      </div>
      {line && <p className="text-xs text-text-muted md:col-start-2 md:col-span-2">{line}</p>}
      {uncertain && (
        <p className="text-xs text-warning-strong md:col-start-2 md:col-span-2">{TIME_UNCERTAIN_NOTE}</p>
      )}
    </li>
  );
}

export function DoorHistoryCard(props: { onlyWithRows?: boolean } = {}) {
  const { onlyWithRows = false } = props;
  const [rows, setRows] = useState<MemberDoorHistoryRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [retention, setRetention] = useState<number | null>(null);
  /** The club's own zone, off the same read as the rows. WIRE-R2 §4. */
  const [timezone, setTimezone] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>("loading");
  const [moreFailed, setMoreFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * When the rows on screen were read. D14.
   *
   * <p>
   * This card is read on mount and never polled, deliberately — a member scanning back
   * through their own record should control every fetch. The cost of that decision is a
   * page that can sit open for an hour showing rows from an hour ago with nothing on it
   * to say so, and nothing short of a full reload to ask again. Both halves were missing
   * and both are one line.
   * </p>
   */
  const [readAt, setReadAt] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);

  const load = useCallback(async (from: string | null) => {
    setBusy(true);
    setMoreFailed(false);
    try {
      const page = await endpoints.meDoorHistory(from ? { cursor: from } : {});
      // A reply with no list is a failed read, not an empty history: reading it as [] would tell
      // the member they have never used a door, and dereferencing it took the whole Profile down.
      if (!Array.isArray(page?.items)) throw new Error("door history reply carried no items");
      // Appended, never replaced: a Show more that fails must leave what is on screen.
      setRows((current) => (from ? [...current, ...page.items] : page.items));
      setCursor(page.next_cursor);
      setRetention(page.retention_days ?? null);
      setTimezone(page.timezone ?? undefined);
      setReadAt(new Date().toISOString());
      setPhase("ready");
    } catch {
      if (from) setMoreFailed(true);
      else setPhase("failed");
    } finally {
      setBusy(false);
    }
  }, []);

  // R13 X13-1: the last page takes "Show more" away with it, so the first row it drew takes focus
  // (or the last row, when every row it brought collapsed into the last group — R3-31).
  const loadOlder = useCallback(() => load(cursor), [load, cursor]);
  const showMore = usePagedFocus("[data-door-history-row]", loadOlder);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader, the house idiom
  useEffect(() => { void load(null); }, [load]);

  /**
   * D9 — the link from `/my-code` has to LAND on this heading, not near it.
   *
   * <p>
   * `/profile#door-history` scrolled, and the browser's own anchor jump put the heading at
   * y = −29 on one viewport and y = −335 on another, because the card mounts and then grows
   * by several hundred pixels as its rows arrive underneath the jump. So the scroll happens
   * once the rows are in, and it moves FOCUS as well as the viewport — C15's other half,
   * without which a screen-reader user who followed the link is still at the top of the page
   * with no idea anything happened.
   * </p>
   */
  useEffect(() => {
    if (phase === "loading") return;
    if (window.location.hash.replace("#", "") !== HISTORY_ANCHOR) return;
    const node = heading.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    // Guarded, and not as a formality. `scrollIntoView` is absent in jsdom and in some
    // embedded webviews, and an effect that throws is re-thrown by React during commit and
    // takes the whole tree down with it — so an unguarded convenience here would blank the
    // member's Profile page on any browser that lacks it. Focus is the half that matters
    // and it has already happened.
    node.scrollIntoView?.({ block: "start", behavior: "auto" });
  }, [phase]);

  // D11's other half: with the door question unanswered, this card speaks only when it has
  // something of the member's own to show. It never tells a club with no doors that it has
  // no door history.
  if (onlyWithRows && !(phase === "ready" && rows.length > 0)) return null;

  const ready = phase === "ready";
  return (
    // C15 — a NAMED REGION, so a screen-reader user can find it in the landmark list and
    // knows what they have landed in when the link from `/my-code` drops them here.
    // `scroll-mt-20` is D9's other half — the app header is sticky, so an anchor jump that
    // lands the heading at the top of the VIEWPORT lands it underneath the header.
    <Card
      id={HISTORY_ANCHOR}
      role="region"
      aria-labelledby={`${HISTORY_ANCHOR}-heading`}
      aria-busy={busy || undefined}
      className="scroll-mt-20"
    >
      <CardHeader>
        {/* `tabindex=-1` so the hash link can focus it; it is not in the tab order. An h2:
            on Profile this card is a top-level section of the page. */}
        <CardTitle asChild>
          <h2 id={`${HISTORY_ANCHOR}-heading`} ref={heading} tabIndex={-1}>{HISTORY_TITLE}</h2>
        </CardTitle>
        <CardDescription>{HISTORY_INTRO}</CardDescription>
        {/* R3 — refresh is the right-aligned icon button, beside the title, never a text
            button in the footer. It spins while the read is in flight. */}
        {phase !== "loading" && (
          <CardAction>
            <RefreshButton label={HISTORY_REFRESH} loading={busy} onRefresh={() => void load(null)} />
          </CardAction>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/*
          P2, stated rather than implied by the chips. Not optional: without it "Lock
          released" is read as "the door opened and somebody went through it".

          C15 — PLAIN TEXT, not `Alert`: `Alert`'s info tone is a live region, and this
          permanent explanatory paragraph was announced as an update on every render.
        */}
        <p className="flex items-start gap-2 rounded-lg bg-info-soft px-3 py-2.5 text-sm text-info-strong">
          <Info size={16} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{HISTORY_P2_NOTICE}</span>
        </p>

        {phase === "loading" && <HistorySkeleton />}

        {phase === "failed" && (
          <div className="flex flex-col items-start gap-3">
            <p className="flex items-start gap-2 text-sm font-medium text-danger-strong">
              <WarningCircle size={16} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0" />
              <span>{HISTORY_FAILED}</span>
            </p>
            <Button variant="outline" pending={busy} onClick={() => void load(null)}>{HISTORY_RETRY}</Button>
          </div>
        )}

        {ready && rows.length === 0 && (
          <p className="text-sm text-text-secondary">{HISTORY_EMPTY}</p>
        )}

        {ready && rows.length > 0 && (
          <ul className="divide-y divide-border">
            {groupHistoryRows(rows, timezone).map((group, i) => (
              <HistoryRow key={`${group.row.at}-${i}`} group={group} timezone={timezone} />
            ))}
          </ul>
        )}

        {moreFailed && <p className="text-sm font-medium text-danger-strong">{HISTORY_MORE_FAILED}</p>}

        {ready && cursor && (
          <Button variant="outline" block pending={busy} onClick={showMore}>
            {HISTORY_SHOW_MORE}
          </Button>
        )}
      </CardContent>

      {ready && (
        <CardFooter className="flex-col items-start gap-1 border-t border-border pt-4 sm:pt-6">
          {/* Once per list. Every face in it is the club's day, which is the right choice
              and an invisible one for a member reading it from anywhere else. */}
          {rows.length > 0 && <p className="text-xs text-text-muted">{CLUB_TIME_NOTE}</p>}
          {/* Only when a row on screen was actually decided offline, because only then is
              it true. See the constant. */}
          {rows.some((row) => !!row.delivered_at) && (
            <p className="text-xs text-text-muted">{HISTORY_DELIVERY_ORDER}</p>
          )}
          <p className="text-xs text-text-muted">
            {readAt && `${historyAsOf(clubClock(readAt, timezone))} `}{historyRetention(retention)}
          </p>
        </CardFooter>
      )}
    </Card>
  );
}

/** The list's shape while the first read is in flight — never "Loading…" on its own (R12). */
function HistorySkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      <p role="status" className="sr-only">{HISTORY_LOADING}</p>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center justify-between gap-3">
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      ))}
    </div>
  );
}
