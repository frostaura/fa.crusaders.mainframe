import { useCallback, useEffect, useState } from "react";
import { Card } from "../Card";
import { Button, Badge } from "../Button";
import { Alert } from "../Alert";
import { endpoints, type MemberDoorHistoryRow } from "../../lib/api";
import { formatDayAndClock } from "../../lib/countdown";
import {
  HISTORY_ANCHOR,
  HISTORY_EMPTY,
  HISTORY_FAILED,
  HISTORY_INTRO,
  HISTORY_LOADING,
  HISTORY_MORE_FAILED,
  HISTORY_P2_NOTICE,
  HISTORY_RETRY,
  HISTORY_SHOW_MORE,
  HISTORY_TITLE,
  UNNAMED_DOOR,
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
 */

type Phase = "loading" | "ready" | "failed";

function HistoryRow({ row }: { row: MemberDoorHistoryRow }) {
  const chip = historyChip(row);
  const line = historyLine(row);
  return (
    <li className="py-3 md:grid md:grid-cols-[auto_1fr_auto] md:items-baseline md:gap-3">
      <p className="text-sm tabular-nums">{formatDayAndClock(row.at)}</p>
      <div className="flex items-center justify-between gap-2 md:contents">
        <p className="text-sm text-text-secondary">{row.door_name ?? UNNAMED_DOOR}</p>
        <Badge tone={chip.tone}>{chip.label}</Badge>
      </div>
      {line && <p className="text-xs text-text-muted md:col-start-2 md:col-span-2">{line}</p>}
    </li>
  );
}

export function DoorHistoryCard() {
  const [rows, setRows] = useState<MemberDoorHistoryRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [retention, setRetention] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [moreFailed, setMoreFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (from: string | null) => {
    setBusy(true);
    setMoreFailed(false);
    try {
      const page = await endpoints.meDoorHistory(from ? { cursor: from } : {});
      // Appended, never replaced: a Show more that fails must leave what is on screen.
      setRows((current) => (from ? [...current, ...page.items] : page.items));
      setCursor(page.next_cursor);
      setRetention(page.retention_days ?? null);
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

  return (
    <Card id={HISTORY_ANCHOR} className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">{HISTORY_TITLE}</h2>
        <p className="text-sm text-text-secondary">{HISTORY_INTRO}</p>
      </div>

      {/* P2, stated rather than implied by the chips. Not optional: without it "Lock
          released" is read as "the door opened and somebody went through it". */}
      <Alert tone="info">{HISTORY_P2_NOTICE}</Alert>

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
        <ul className="divide-y divide-border">
          {rows.map((row, i) => <HistoryRow key={`${row.at}-${i}`} row={row} />)}
        </ul>
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

      {phase === "ready" && <p className="text-xs text-text-muted">{historyRetention(retention)}</p>}
    </Card>
  );
}
