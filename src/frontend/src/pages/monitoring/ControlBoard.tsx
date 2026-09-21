import { useEffect, useState } from "react";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import { MonitoringNav } from "../../components/monitoring/MonitoringSection";
import { CourtTile } from "../../components/monitoring/CourtTile";
import { StateBlock } from "../../components/StateBlock";
import { useControlBoard } from "../../lib/useControlBoard";
import { useTicker } from "../../lib/useTicker";
import { clubClock } from "../../lib/clubClock";
import { endpoints, type AdminSettings } from "../../lib/api";
import { type ControlBoardCourt } from "../../lib/adminApi";
import {
  BOARD_EMPTY_HINT, BOARD_EMPTY_NOTICE, BOARD_NO_REMOTE_CONTROL, BOARD_STANDING_NOTICE,
  WALL_VIEW_HINT, WALL_VIEW_LABEL, boardStaleBand, courtExpectation, freshnessLine,
  partialBoardNotice,
} from "../../lib/monitoringCopy";

/**
 * The Control Board — GOAL item 10. `/admin/monitoring`.
 *
 * <p>
 * <b>What this page is for, in one sentence:</b> an admin standing at the desk at 18:02 on a
 * league night wants to know which courts should have their lights on, who is on them, how
 * long they have left, and which board has stopped talking — without opening four screens.
 * </p>
 *
 * <p>
 * <b>And what it refuses to be.</b> It is a mirror, not a control panel. The court box is
 * pull-only: `IRelayClient` is not registered in the container, the heartbeat response
 * carries no command field, and there is no channel over which this page could switch a
 * relay. So there is no on/off control — not a disabled one, not a hidden one. A greyed-out
 * "Turn on lights" is a promise the product cannot keep, and the audience here is people who
 * will press it and then walk to a dark court. {@link BOARD_NO_REMOTE_CONTROL} says so in
 * words, once, on the page.
 * </p>
 *
 * <p>
 * <b>Freshness is stated, never implied.</b> Four modes — connecting, live, re-reading every
 * N seconds, and cannot reach the club — and the page says which one it is in at all times.
 * A wall tablet that silently stopped updating is the worst thing this page could do, because
 * nothing about it looks wrong.
 * </p>
 */

/**
 * The courts whose box has stopped talking, by name.
 *
 * Named rather than counted: "3 of 4 boards reported" sends nobody anywhere, and the whole
 * value of this page to somebody standing in a club is that it says which shelf to walk to.
 */
function silentCourtNames(courts: ControlBoardCourt[]): string[] {
  return courts.filter((c) => courtExpectation(c) === "unknown").map((c) => c.name);
}

/**
 * Wall view, remembered per DEVICE.
 *
 * <p>
 * `localStorage` and not a tenant setting, deliberately: the tablet screwed to the wall and
 * the admin's laptop are two different readers of one club, and a club-wide "everything is
 * huge now" is not what the person who turned it on meant. It is also the one piece of state
 * here that is genuinely per-viewer, which is the whole of what browser storage is for.
 * </p>
 *
 * <p>
 * Every read and write is guarded: a private window, cleared site data or a blocked-storage
 * policy makes the accessor throw, and a page that cannot render because it could not read a
 * display preference is a worse failure than a page that is the wrong size.
 * </p>
 */
const WALL_KEY = "crusaders.controlBoard.wall";

function readWallPreference(): boolean {
  try { return window.localStorage.getItem(WALL_KEY) === "1"; } catch { return false; }
}

export function ControlBoardPage() {
  const { view, loading, error, mode, readAt, refresh } = useControlBoard();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [wall, setWall] = useState(readWallPreference);
  // One instant per paint. Three tiles rendering across a second boundary must not print two
  // different moments for one clock, which is why `relative` and the countdown both take it.
  const now = useTicker(true);

  useEffect(() => {
    let cancelled = false;
    // The grace window, for the DUE sentence. Its failure is not this page's failure — the
    // sentence drops the clause rather than printing a number it does not have.
    endpoints.adminSettingsGet()
      .then((s) => { if (!cancelled) setSettings(s); })
      .catch(() => { /* the sentence has a no-number arm */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem(WALL_KEY, wall ? "1" : "0"); } catch { /* see WALL_KEY */ }
  }, [wall]);

  const courts: ControlBoardCourt[] = view?.courts ?? [];
  const timezone = view?.timezone;
  const readAtFace = readAt === null ? null : clubClock(readAt, timezone);
  const silent = silentCourtNames(courts);
  const partial = partialBoardNotice(silent, readAtFace);
  /*
   * `error` is `unknown` — deliberately, because `describeFailure` is the only thing that may
   * interpret it — so the page asks the boolean question it actually has: did the last read
   * fail while we still hold tiles worth showing?
   */
  const unreachable = error !== null && error !== undefined;

  return (
    // `--board-scale` is declared here and consumed ONLY by CourtTile. Wall view is therefore
    // one declaration rather than a second set of class strings that drift from the first.
    <div className="space-y-6" style={wall ? ({ "--board-scale": "1.6" } as React.CSSProperties) : undefined}>
      <header className="space-y-3">
        <div className="sm:flex sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">Control board</h1>
            {/* The freshness line is a fact about the SCREEN and changes on a timer, so it
                lives in a polite region of its own rather than being read out on every tick. */}
            <p className="text-xs text-text-muted" data-testid="board-freshness">
              {freshnessLine(mode, 10, readAtFace)}
            </p>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 sm:mt-0">
            <label className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-control bg-bg-surface px-3 text-sm font-medium">
              <input
                type="checkbox"
                checked={wall}
                onChange={(e) => setWall(e.target.checked)}
                className="h-5 w-5"
              />
              {WALL_VIEW_LABEL}
            </label>
            {/* Never `disabled` while it is working: a browser blurs a disabled element, so
                disabling the control somebody just pressed throws their place away. */}
            <Button variant="outline" className="min-h-11" onClick={() => void refresh()}>Refresh</Button>
          </div>
        </div>
        <p className="text-xs text-text-muted">{WALL_VIEW_HINT}</p>
        <MonitoringNav />
      </header>

      {/*
        The two standing facts, and they are `standing` rather than `polite` because this page
        re-renders itself every few seconds: a polite region announces on every remount, which
        over an evening on a wall is the same forty-word paragraph several hundred times.
      */}
      <Alert tone="info" live="standing" announceKey="control-board-what-this-is">
        {BOARD_STANDING_NOTICE}
      </Alert>

      {partial && (
        <Alert tone="warning" live="standing" announceKey={`control-board-silent:${silent.join(",")}`}>
          {partial}
        </Alert>
      )}

      {/*
        <b>The failed read keeps the tiles.</b> This is the one place in the product where the
        ordinary rule bends, and it bends on purpose: on a wall, what the club last knew is the
        only information in the building, and blanking it loses it. What is forbidden is
        showing it unqualified — hence the band, with a real timestamp, above tiles that are
        explicitly not being updated.
      */}
      {unreachable && courts.length > 0 && (
        <div className="space-y-3">
          <Alert tone="danger" live="standing" announceKey="control-board-unreachable">
            {boardStaleBand(readAtFace)}
          </Alert>
          <Button variant="outline" className="min-h-11" onClick={() => void refresh()}>Try again</Button>
        </div>
      )}

      <StateBlock
        loading={loading}
        // Only when there is nothing at all to fall back on. With tiles in hand the band
        // above has already said what is wrong, and StateBlock would replace them with it.
        error={courts.length > 0 ? null : error}
        action="the club's courts"
        failedCaveat="Nothing here is being updated while that is true."
        onRetry={() => void refresh()}
        empty={!loading && !error && courts.length === 0}
        emptyTitle={BOARD_EMPTY_NOTICE}
        emptyHint={BOARD_EMPTY_HINT}
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {courts.map((court) => (
            <CourtTile
              key={court.court_id}
              court={court}
              now={now}
              timezone={timezone}
              graceMinutes={settings?.grace_window_minutes ?? null}
            />
          ))}
        </div>
      </StateBlock>

      <p className="text-sm text-text-muted">{BOARD_NO_REMOTE_CONTROL}</p>
    </div>
  );
}
