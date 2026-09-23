import { useEffect, useState, type CSSProperties } from "react";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/ui/button";
import { InfoPopover } from "../../components/ui/info-popover";
import { PageHeader, PageShell } from "../../components/ui/page-shell";
import { RefreshButton } from "../../components/ui/refresh-button";
import { StateBlock } from "../../components/ui/state-block";
import { Switch } from "../../components/ui/switch";
import { Prohibit, Racquet } from "../../components/ui/icons";
import { CourtTile } from "../../components/monitoring/CourtTile";
import { TileGridSkeleton } from "../../components/monitoring/parts";
import { useAsyncAction } from "../../lib/useAsyncAction";
import { cn } from "../../lib/utils";
import { useControlBoard } from "../../lib/useControlBoard";
import { useTicker } from "../../lib/useTicker";
import { clubClock } from "../../lib/clubClock";
import { endpoints, type AdminSettings } from "../../lib/api";
import { type ControlBoardCourt } from "../../lib/adminApi";
import {
  BOARD_EMPTY_HINT, BOARD_EMPTY_NOTICE, BOARD_NO_REMOTE_CONTROL, BOARD_STANDING_NOTICE,
  WALL_VIEW_HINT, WALL_VIEW_LABEL, boardStaleBand, courtExpectation, freshnessLine,
  partialBoardNotice, type FreshnessMode,
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
  // A press shows its own pending state; the poll behind it never does.
  const manual = useAsyncAction(refresh);

  return (
    // `--board-scale` is declared on the shell and consumed ONLY by CourtTile. Wall view is
    // therefore one declaration rather than a second set of class strings that drift from the first.
    <PageShell width="wide" style={wall ? ({ "--board-scale": "1.6" } as CSSProperties) : undefined}>
      <PageHeader
        title="Control board"
        // The freshness line is a fact about the SCREEN and changes on a timer: it is the
        // header's description rather than a live region, so it is never read out on a tick.
        description={<BoardFreshness mode={mode} line={freshnessLine(mode, 10, readAtFace)} />}
        actions={<RefreshButton onRefresh={() => void manual.run()} loading={manual.pending} />}
      />
      {/* A display preference, so it sits with the page rather than in the header's icon
          column — a worded switch beside the title does not fit a 360px phone. */}
      <div className="-mt-4 flex items-center">
        <WallViewSwitch wall={wall} onWall={setWall} />
      </div>

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
        <div className="flex flex-col items-start gap-3">
          <Alert tone="danger" live="standing" announceKey="control-board-unreachable" className="w-full">
            {boardStaleBand(readAtFace)}
          </Alert>
          <Button variant="outline" pending={manual.pending} onClick={() => void manual.run()}>Try again</Button>
        </div>
      )}

      <StateBlock
        loading={loading}
        // Only when there is nothing at all to fall back on. With tiles in hand the band
        // above has already said what is wrong, and StateBlock would replace them with it.
        error={courts.length > 0 ? null : error}
        action="the club's courts"
        failedCaveat="Nothing here is being updated while that is true."
        onRetry={() => void manual.run()}
        empty={!loading && !error && courts.length === 0}
        emptyTitle={BOARD_EMPTY_NOTICE}
        emptyHint={BOARD_EMPTY_HINT}
        emptyIcon={Racquet}
        skeleton={<TileGridSkeleton tiles={4} />}
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

      <p className="flex items-start gap-2 text-sm text-text-muted">
        <Prohibit size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>{BOARD_NO_REMOTE_CONTROL}</span>
      </p>
    </PageShell>
  );
}

/** The mode dot: a word first, colour second — a wall read by a colour-blind admin still says it. */
const MODE_DOT: Record<FreshnessMode, string> = {
  connecting: "bg-text-muted",
  live: "bg-success-strong",
  polling: "bg-warning-strong",
  lost: "bg-danger-strong",
};

function BoardFreshness({ mode, line }: { mode: FreshnessMode; line: string }) {
  return (
    <span className="inline-flex items-start gap-2">
      <span aria-hidden="true" className={cn("mt-1.5 size-2 shrink-0 rounded-full", MODE_DOT[mode])} />
      <span data-testid="board-freshness">{line}</span>
    </span>
  );
}

/**
 * Wall view: a Switch, because it is a setting that takes effect at once — never a checkbox in a
 * bordered box posing as a button. The hint that used to sit under the header as a paragraph is
 * guidance, so it lives behind the (i) beside the switch.
 */
function WallViewSwitch({ wall, onWall }: { wall: boolean; onWall: (next: boolean) => void }) {
  return (
    <div className="inline-flex items-center">
      <label className="inline-flex min-h-touch cursor-pointer items-center gap-2 pr-1 text-sm font-medium text-text-secondary">
        <Switch checked={wall} onCheckedChange={onWall} />
        {WALL_VIEW_LABEL}
      </label>
      <InfoPopover label={WALL_VIEW_LABEL} side="bottom">{WALL_VIEW_HINT}</InfoPopover>
    </div>
  );
}
