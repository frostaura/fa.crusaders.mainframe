import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Panel as Card } from "../components/ui/card";
import { Alert } from "../components/Alert";
import { Button } from "../components/ui/button";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { RefreshButton } from "../components/ui/refresh-button";
import { Skeleton } from "../components/ui/skeleton";
import { StateBlock } from "../components/ui/state-block";
import { TextLink } from "../components/ui/text-link";
import { Door } from "../components/ui/icons";
import { useAsyncAction } from "../lib/useAsyncAction";
import { ConfirmDialog } from "../components/admin/ConfirmDialog";
import { splitQuestion } from "../lib/confirmCopy";
import { DoorAge } from "../components/doors/DoorAge";
import { DoorChips } from "../components/doors/DoorChips";
import { DoorFeed } from "../components/doors/DoorFeed";
import { DoorShutControl } from "../components/doors/DoorShutControl";
import { DoorSignalNotices } from "../components/doors/DoorSignalNotices";
import { DoorCardSection } from "../components/doors/DoorCardSection";
import {
  DOORS_PAGE_INTERVAL_MS, refreshDoorsView, useDoorsStore,
} from "../components/doors/useDoorsChrome";
import { useDoorActions, type DoorActions } from "../components/doors/useDoorActions";
import { useTicker } from "../lib/useTicker";
import { clubDayAndClock } from "../lib/clubClock";
import { isOnline, offlineAfterSecondsFor } from "../lib/deviceLiveness";
import {
  DOORS_READ_FAILED, doorDisplayName, doorEventsLostNotice, doorStateNotice,
} from "../lib/doorsCopy";
import { UNNAMED_GATE, gateDeleteConfirm, gateDeleteStandingNotice } from "../lib/gateCopy";
import { ACTIVITY_READ_FAILED } from "../lib/deviceActivity";
import { describeDeviceError } from "../lib/deviceErrors";
import { withDoorsBoundary } from "../components/doors/DoorsErrorBoundary";
import {
  endpoints, type AdminDoorDevice, type AdminSettings, type DeviceActivityEntry,
  type DoorEventEntry, type DoorsView,
} from "../lib/api";

/**
 * One door — arrived at because something is wrong, or because a member complained about
 * last night.
 *
 * <p>
 * Read before write: the state and the feed are above the controls, and the door card sits
 * between them because the person reading it is often about to walk to the board.
 * </p>
 */

/** The club's own numbers, or nulls where the settings read failed. Never guessed. */
function signalSettingsOf(settings: AdminSettings | null) {
  return {
    spikeMinutes: settings?.door_refusal_spike_minutes ?? null,
    unlockSeconds: settings?.gate_unlock_seconds ?? null,
  };
}

/** A13 / B20: the shared club-locale face, and never a bare weekday. */
function shutAtFace(iso: string | null, timezone: string): string | null {
  return iso ? clubDayAndClock(iso, timezone) : null;
}

/** The parent page, as the page header's back link — one shape on every detail screen (R11). */
const BACK_TO_DOORS = { to: "/admin/monitoring/doors", label: "Doors" };

/** Everything one door's page reads, and whether each read landed. */
type DoorPageRead = {
  view: DoorsView | null;
  settings: AdminSettings | null;
  entries: DeviceActivityEntry[] | null;
  /** Undefined until the read lands, and still undefined against an API that sends none. */
  events?: DoorEventEntry[] | null;
  feedError: string | null;
  feedLoading: boolean;
  loading: boolean;
  failed: boolean;
};

/**
 * The one door this page is about, pulled out of the read.
 *
 * A function rather than four `??`s inside the component: each of those is a branch the
 * complexity gate counts, and a page component that is a loader and a layout should measure
 * as one.
 */
function doorOf(read: DoorPageRead, id: string, now: number) {
  const row = read.view?.doors.find((d) => d.device.id === id);
  const timezone = read.view?.timezone ?? "UTC";
  // A placeholder while the read has not landed or the door has gone: every branch that
  // could render it returns before the door is used, and the actions hook has to be called
  // unconditionally either way.
  const door = row?.device ?? ({ id, name: "" } as AdminDoorDevice);
  const online = row
    ? isOnline(door, offlineAfterSecondsFor(door, read.settings?.heartbeat_seconds ?? null), now)
    : false;
  return { row, door, timezone, online };
}

function useDoorPage(id: string) {
  const [read, setRead] = useState<DoorPageRead>({
    view: null, settings: null, entries: null, feedError: null,
    feedLoading: true, loading: true, failed: false,
  });
  // E-L6: the doors read comes from the shared store — the page no longer makes its own.
  // B1: and it is the store that keeps it fresh, at the page's cadence.
  const store = useDoorsStore(true, DOORS_PAGE_INTERVAL_MS);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors the store into this page's one read object
    setRead((r) => ({
      ...r,
      view: store.view,
      failed: store.failed && store.view === null,
      loading: store.loading && store.view === null,
    }));
  }, [store.view, store.failed, store.loading]);

  const reload = useCallback(async () => {
    await refreshDoorsView();
  }, []);

  /**
   * <b>B1: the feed re-reads too, every fifteen seconds while the tab is in front.</b>
   *
   * The detail page made zero repeat requests over seventy seconds while its relative clocks
   * went on ticking: another admin's shut was invisible, "Shut this door" was still offered
   * for a door that was already shut, and no banner appeared. The overview polled and this
   * page — the one somebody opens BECAUSE something is wrong — did not.
   */
  const readFeed = useCallback(async () => {
    try {
      const page = await endpoints.adminDeviceActivity(id);
      setRead((r) => ({
        ...r, entries: page.items, events: page.events ?? null, feedError: null, feedLoading: false,
      }));
    } catch (e) {
      const feedError = describeDeviceError(e, ACTIVITY_READ_FAILED);
      setRead((r) => ({ ...r, entries: null, events: null, feedError, feedLoading: false }));
    }
  }, [id]);

  const load = useCallback(async () => {
    await refreshDoorsView();
    // The settings read's failure is not the page's: signals simply do not render, rather
    // than rendering a threshold nobody set.
    try {
      const settings = await endpoints.adminSettingsGet();
      setRead((r) => ({ ...r, settings }));
    } catch { /* the signal notices take their no-number arm */ }
    await readFeed();
  }, [readFeed]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      void readFeed();
    };
    const onVisibility = () => { if (document.visibilityState === "visible") tick(); };
    const feedTimer = setInterval(tick, DOORS_PAGE_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(feedTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [readFeed]);

  return { read, load, reload };
}

/**
 * The write controls, under the door card.
 *
 * <p>
 * <b>A8 / B12 / C15: it is a headed, explained block now, not an unheaded strip that starts
 * mid-thought.</b> A volunteer met it as a sentence with no subject, in our vocabulary
 * ("the API", "roster", "heartbeat", "re-registers"), with the explanation printed ABOVE the
 * button it belonged to.
 * </p>
 *
 * <p>
 * <b>A12: every consequence is visible at rest, beside its own control, as a statement.</b>
 * Delete's was printed permanently while Shut's was hidden until the control was armed — so
 * the two destructive controls on one card taught opposite lessons about where to look, and
 * the one with the larger consequence taught the worse one. Both are stated, both as
 * statements rather than as questions: a question at rest reads as a control that is already
 * asking, which is what an armed control looks like.
 * </p>
 */
function DoorControls({ door, displayName, actions, online, shutAt, timezone }: {
  door: AdminDoorDevice;
  /** A11 / R3-21: what an admin calls this door — never the raw registration placeholder. */
  displayName: string;
  actions: DoorActions;
  online: boolean;
  shutAt: string | null;
  /** The club's zone — R3-3: every face on this surface is written in it, never the browser's. */
  timezone: string;
}) {
  return (
    <section aria-labelledby="door-controls-heading" className="space-y-2">
      <h2 id="door-controls-heading" className="text-lg font-semibold">Shutting or removing this door</h2>
      <Card className="space-y-4">
        <DoorShutControl
          door={door}
          onDone={actions.setEnabled}
          shutAt={shutAt}
          online={online}
          timezone={timezone}
        />
        <div className="space-y-2 border-t border-border pt-4">
          {/* The consequence is rendered as page text as well as on the confirm, because
              `ConfirmButton`'s aria-label replaces its contents: without this sentence a
              screen-reader user arming the control hears only "choose again to confirm". */}
          <p className="text-sm text-text-secondary">{gateDeleteStandingNotice(displayName)}</p>
          {/* Confirmed in a dialog (P3). No `focusAfter`: a successful delete navigates to the
              doors list, and the page it lands on moves focus itself. */}
          <ConfirmDialog
            trigger={(
              <Button variant="danger-soft" block className="!h-auto min-h-touch whitespace-normal py-2">
                Delete this door{" "}<span className="sr-only">{`— ${displayName}`}</span>
              </Button>
            )}
            title={splitQuestion(gateDeleteConfirm()).question ?? "Delete this door?"}
            description={splitQuestion(gateDeleteConfirm()).consequence}
            confirmLabel="Delete this door"
            cancelLabel="Keep this door"
            onConfirm={actions.remove}
          />
        </div>
      </Card>
    </section>
  );
}

function AdminDoorsDetailPageBody() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const now = useTicker(true);
  const { read, load, reload } = useDoorPage(id);
  // A press re-reads all three halves (doors, settings, the feed) and shows it is working.
  const manual = useAsyncAction(load);
  // A19: ONE form over all four writable fields, so one boolean rather than a "which of the
  // two editors is open" discriminator.
  const [editing, setEditing] = useState(false);

  const { row, door, timezone, online } = doorOf(read, id, now);
  const displayName = doorDisplayName(door);
  const actions = useDoorActions(door, {
    online,
    timezone,
    reload,
    // A-M7 / R3-14: the confirmation travels WITH the navigation. Pushed as a toast and then
    // navigated away from in the same tick, it was in practice never seen — and the page it
    // lands on is a list that polls, so one fewer row reads as a board dropping off.
    afterDelete: (said: string) => nav("/admin/monitoring/doors", { state: { doorsNotice: said } }),
  });

  if (read.loading) {
    // A skeleton the shape of the page (R12): header, the controls column, the feed.
    return (
      <PageShell width="wide" aria-busy="true">
        <p className="sr-only">Reading this door…</p>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-8 w-64 max-w-full" />
          <Skeleton className="h-4 w-48 max-w-full" />
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <Skeleton className="h-64 lg:col-span-2" />
          <Skeleton className="h-64" />
        </div>
      </PageShell>
    );
  }
  if (read.failed) {
    return (
      <PageShell width="wide">
        <PageHeader back={BACK_TO_DOORS} title="Door" />
        <div className="flex flex-col items-start gap-3">
          <Alert tone="danger" className="w-full">{DOORS_READ_FAILED}</Alert>
          <Button variant="outline" onClick={() => void load()}>Try again</Button>
        </div>
      </PageShell>
    );
  }
  if (!row) {
    return (
      <PageShell width="wide">
        <PageHeader back={BACK_TO_DOORS} title="Door not found" />
        <StateBlock
          empty
          emptyIcon={Door}
          emptyTitle="That door is not on the club's list."
          emptyHint="It may have been deleted — a board re-registers itself on its next heartbeat, with no name."
          emptyAction={<TextLink variant="standalone" to="/admin/monitoring/doors">See every door</TextLink>}
        />
      </PageShell>
    );
  }

  return (
    <PageShell width="wide">
      {/* A11 / R3-21: ONE fallback. This printed the raw `name`, which for a board nobody has
          named is the registration placeholder "Door gate" — so the heading, the identity line
          below it ("no door name yet") and the tile that linked here ("Unnamed scanner
          (gate-44c103)") were three vocabularies for one state, and the loudest was a word the
          club never chose and cannot tell apart from the other four doors in it.
          B1: it polls, and it says so — the description names the interval. A page that
          re-reads silently is only half the fix: the reader has to know how fresh it is. */}
      <PageHeader
        back={BACK_TO_DOORS}
        title={displayName}
        description={(
          <>
            <span className="block min-w-0 break-words font-mono text-xs text-text-muted">
              {`${door.gate_key ?? UNNAMED_GATE} · ${door.device_code}`}
            </span>
            <span className="block">{`Re-reads every ${DOORS_PAGE_INTERVAL_MS / 1000} seconds while this tab is in front.`}</span>
          </>
        )}
        actions={<RefreshButton onRefresh={() => void manual.run()} loading={manual.pending} />}
      />
      <div className="-mt-4 flex flex-wrap items-center gap-3">
        <DoorChips device={door} online={online} />
        <DoorAge at={door.last_seen_at} now={now} prefix={online ? "Heard from" : "Last heard from"} />
      </div>

      {doorStateNotice(door, online, timezone) && (
        <Card><p className="text-sm text-text-secondary">{doorStateNotice(door, online, timezone)}</p></Card>
      )}

      {/* G4c / R3-33: records this door threw away. Not a live region — it is a standing
          fact about a board, and this page re-reads every fifteen seconds (C-M2). */}
      {doorEventsLostNotice(door) && (
        <Card className="border-l-4 border-warning-strong bg-warning-soft">
          <p className="text-sm text-warning-strong">{doorEventsLostNotice(door)}</p>
        </Card>
      )}

      <DoorSignalNotices
        doorName={displayName}
        signals={row.signals}
        settings={signalSettingsOf(read.settings)}
        enabled={door.enabled}
        online={online}
      />

      {/*
        <b>B6: state and controls FIRST, then the door card, then the scans.</b>

        The controls were the third thing on the page, below a feed of up to fifty rows —
        5 231 px down on a phone, measured. Somebody opens this page because something is
        wrong at a door, and the thing they came to do was two full screens of scrolling
        past the thing they came to read.

        `min-w-0` on the grid AND on the column, and it is load-bearing rather than tidy.
        A grid item's default is `min-width: auto`, so a column refuses to shrink below its
        content's MIN-CONTENT width — and below `lg` this is a one-column grid whose column
        therefore sizes to the widest unbreakable thing inside it. Measured at 360 px with a
        32 px root font (the large-text setting an older volunteer actually uses): the right
        column reported 459 px inside a 360 px viewport, and the whole page scrolled
        sideways by 98 px. The `minmax(0,…)` in the `lg` template says the same thing for
        the two-column case and was always there; the single-column case had nothing.

        On a WIDE screen the two columns put the feed beside the controls, so `order` is a
        phone-width concern only — which is exactly where the 5 231 px was measured.
      */}
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <div className="order-1 min-w-0 space-y-6 lg:order-2">
          <DoorControls
            door={door}
            displayName={displayName}
            actions={actions}
            online={online}
            shutAt={shutAtFace(door.out_of_service_since ?? null, timezone)}
            timezone={timezone}
          />
          <DoorCardSection
            door={door}
            displayName={displayName}
            settings={read.settings}
            editing={editing}
            onEdit={() => setEditing(true)}
            onClose={() => setEditing(false)}
            onSave={actions.save}
          />
        </div>

        <div className="order-2 min-w-0 lg:order-1">
          <DoorFeed
            door={door}
            today={row.today}
            read={{
              entries: read.entries, events: read.events, loading: read.feedLoading, error: read.feedError,
            }}
            clock={{ now, dayStartedAt: read.view!.day_started_at, timezone, online }}
          />
        </div>
      </div>
    </PageShell>
  );
}

/** A1: see {@link AdminDoorsLogPage}. Every doors route is exported through the boundary. */
export const AdminDoorsDetailPage = withDoorsBoundary(AdminDoorsDetailPageBody);
