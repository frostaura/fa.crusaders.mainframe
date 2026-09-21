import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Card } from "../Card";
import { Button, Badge } from "../Button";
import { endpoints, type MemberDoorHistoryRow } from "../../lib/api";
import { clubClock, clubDayAndClock } from "../../lib/clubClock";
import { cn } from "../../lib/utils";
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
  UNNAMED_DOOR,
  historyAsOf,
  historyChip,
  historyLine,
  historyRetention,
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

function HistoryRow({ row, timezone }: { row: MemberDoorHistoryRow; timezone: string | undefined }) {
  const chip = historyChip(row);
  const line = historyLine(row, timezone);
  return (
    <li className="py-3 md:grid md:grid-cols-[auto_1fr_auto] md:items-baseline md:gap-3">
      {/* The club's day, not the viewer's. O1 — and stated once under the list, not here. */}
      <p className="text-sm tabular-nums">{clubDayAndClock(row.at, timezone)}</p>
      <div className="flex items-center justify-between gap-2 md:contents">
        <p className="text-sm text-text-secondary">{row.door_name ?? UNNAMED_DOOR}</p>
        <Badge tone={chip.tone}>{chip.label}</Badge>
      </div>
      {line && <p className="text-xs text-text-muted md:col-start-2 md:col-span-2">{line}</p>}
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

  return (
    // C15 — a NAMED REGION, so a screen-reader user can find it in the landmark list and
    // knows what they have landed in when the link from `/my-code` drops them here. `role`
    // on the Card rather than a `<section>` wrapper around it: `Card` spreads
    // HTMLAttributes, and a second box inside the first is a border nobody asked for.
    //
    // `scroll-mt-20` is D9's other half — the app header is sticky, so an anchor jump that
    // lands the heading at the top of the VIEWPORT lands it underneath the header.
    <Card
      id={HISTORY_ANCHOR}
      role="region"
      aria-labelledby={`${HISTORY_ANCHOR}-heading`}
      className="space-y-4 scroll-mt-20"
    >
      <>
        <div>
          {/* `tabindex=-1` so the hash link can focus it; it is not in the tab order. */}
          <h2 id={`${HISTORY_ANCHOR}-heading`} ref={heading} tabIndex={-1} className="text-base font-semibold">
            {HISTORY_TITLE}
          </h2>
          <p className="text-sm text-text-secondary">{HISTORY_INTRO}</p>
        </div>

        {/*
          P2, stated rather than implied by the chips. Not optional: without it "Lock
          released" is read as "the door opened and somebody went through it".

          C15 — PLAIN TEXT, not `Alert`. `Alert`'s info tone carries `role="status"`, which
          is a live region: this permanent explanatory paragraph was therefore announced as
          an update every single time the section rendered, including on arrival from the
          `/my-code` link. A live region is for something that has just changed; a sentence
          that has been true since the card was written is not that.
        */}
        <p className="rounded-lg border-l-4 border-info-strong bg-info-soft px-3 py-2.5 text-sm text-info-strong">
          {HISTORY_P2_NOTICE}
        </p>

        {phase === "loading" && <p className="text-sm text-text-secondary">{HISTORY_LOADING}</p>}

        {phase === "failed" && (
          <div className="space-y-3">
            <p className="text-sm text-danger-strong">{HISTORY_FAILED}</p>
            <Button variant="outline" onClick={() => void load(null)} disabled={busy}>{HISTORY_RETRY}</Button>
          </div>
        )}

        {phase === "ready" && rows.length === 0 && (
          <p className="text-sm text-text-secondary">{HISTORY_EMPTY}</p>
        )}

        {phase === "ready" && rows.length > 0 && (
          <>
            <ul className="divide-y divide-border">
              {rows.map((row, i) => <HistoryRow key={`${row.at}-${i}`} row={row} timezone={timezone} />)}
            </ul>
            {/* Once per list. Every face in it is the club's day, which is the right choice
                and an invisible one for a member reading it from anywhere else. */}
            <p className="text-xs text-text-muted">{CLUB_TIME_NOTE}</p>
            {/* Only when a row on screen was actually decided offline, because only then is
                it true — and only then does a member have a row whose own time runs
                backwards against its neighbours to be confused by. See the constant. */}
            {rows.some((row) => !!row.delivered_at) && (
              <p className="text-xs text-text-muted">{HISTORY_DELIVERY_ORDER}</p>
            )}
          </>
        )}

        {moreFailed && (
          <div className="space-y-3">
            <p className="text-sm text-danger-strong">{HISTORY_MORE_FAILED}</p>
          </div>
        )}

        {phase === "ready" && cursor && (
          <Button variant="outline" className="w-full" onClick={() => void load(cursor)} disabled={busy}>
            {HISTORY_SHOW_MORE}
          </Button>
        )}

        {phase === "ready" && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-xs text-text-muted">
              {readAt && `${historyAsOf(clubClock(readAt, timezone))} `}{historyRetention(retention)}
            </p>
            <Button variant="outline" className="px-3 text-xs" onClick={() => void load(null)} disabled={busy}>
              <RefreshCw size={14} className={cn("mr-1", busy && "animate-spin motion-reduce:animate-none")} />
              {HISTORY_REFRESH}
            </Button>
          </div>
        )}
      </>
    </Card>
  );
}
