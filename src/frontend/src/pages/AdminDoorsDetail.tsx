import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Card } from "../components/Card";
import { Alert } from "../components/Alert";
import { Button } from "../components/Button";
import { ConfirmButton } from "../components/ConfirmButton";
import { DoorAge } from "../components/doors/DoorAge";
import { DoorChips } from "../components/doors/DoorChips";
import { DoorFeed } from "../components/doors/DoorFeed";
import { DoorShutControl } from "../components/doors/DoorShutControl";
import { DoorSignalNotices } from "../components/doors/DoorSignalNotices";
import { DoorCardSection } from "../components/doors/DoorCardSection";
import { publishDoorsView } from "../components/doors/useDoorsChrome";
import { useDoorActions, type DoorActions } from "../components/doors/useDoorActions";
import { useTicker } from "../lib/useTicker";
import { clubDayAndClock } from "../lib/clubClock";
import { isOnline, offlineAfterSecondsFor } from "../lib/deviceLiveness";
import { DOORS_READ_FAILED, doorStateNotice } from "../lib/doorsCopy";
import { UNNAMED_GATE, gateDeleteConfirm, gateDeleteStandingNotice } from "../lib/gateCopy";
import { ACTIVITY_READ_FAILED } from "../lib/deviceActivity";
import { describeDeviceError } from "../lib/deviceErrors";
import {
  doorEndpoints, endpoints, type AdminDoorDevice, type AdminSettings, type DeviceActivityEntry,
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

function BackToDoors() {
  return <Link to="/admin/doors" className="inline-flex min-h-11 items-center text-sm text-accent-strong">← Doors</Link>;
}

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

  const reload = useCallback(async () => {
    const view = await doorEndpoints.doors();
    setRead((r) => ({ ...r, view, failed: false }));
    // C3: the chrome's shut banner subscribes to this, so shutting a door from its own page
    // updates the banner without a navigation. Three readers of one fact is how an admin
    // came to see three different door counts on one screen.
    publishDoorsView(view);
  }, []);

  const load = useCallback(async () => {
    try {
      await reload();
    } catch {
      setRead((r) => ({ ...r, failed: true, view: null }));
    } finally {
      setRead((r) => ({ ...r, loading: false }));
    }
    // The settings read's failure is not the page's: signals simply do not render, rather
    // than rendering a threshold nobody set.
    try {
      const settings = await endpoints.adminSettingsGet();
      setRead((r) => ({ ...r, settings }));
    } catch { /* the signal notices take their no-number arm */ }
    try {
      const page = await endpoints.adminDeviceActivity(id);
      setRead((r) => ({
        ...r, entries: page.items, events: page.events ?? null, feedError: null, feedLoading: false,
      }));
    } catch (e) {
      const feedError = describeDeviceError(e, ACTIVITY_READ_FAILED);
      setRead((r) => ({ ...r, entries: null, events: null, feedError, feedLoading: false }));
    }
  }, [id, reload]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { void load(); }, [load]);

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
function DoorControls({ door, actions, online, shutAt }: {
  door: AdminDoorDevice;
  actions: DoorActions;
  online: boolean;
  shutAt: string | null;
}) {
  return (
    <section aria-labelledby="door-controls-heading" className="space-y-2">
      <h2 id="door-controls-heading" className="text-lg font-semibold">Shutting or removing this door</h2>
      <Card className="space-y-4">
        <DoorShutControl door={door} onDone={actions.setEnabled} shutAt={shutAt} online={online} />
        <div className="space-y-2 border-t border-border pt-4">
          {/* The consequence is rendered as page text as well as on the confirm, because
              `ConfirmButton`'s aria-label replaces its contents: without this sentence a
              screen-reader user arming the control hears only "tap again to confirm". */}
          <p className="text-sm text-text-secondary">{gateDeleteStandingNotice(door.name)}</p>
          <ConfirmButton
            idleLabel="Delete this door"
            confirmLabel={gateDeleteConfirm()}
            ariaLabel={door.name}
            onConfirm={actions.remove}
            tone="danger"
            className="min-h-11 w-full"
          />
        </div>
      </Card>
    </section>
  );
}

export function AdminDoorsDetailPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const now = useTicker(true);
  const { read, load, reload } = useDoorPage(id);
  // A19: ONE form over all four writable fields, so one boolean rather than a "which of the
  // two editors is open" discriminator.
  const [editing, setEditing] = useState(false);

  const { row, door, timezone, online } = doorOf(read, id, now);
  const actions = useDoorActions(door, {
    online, timezone, reload, afterDelete: () => nav("/admin/doors"),
  });

  if (read.loading) return <p className="text-sm text-text-secondary">Loading this door…</p>;
  if (read.failed) {
    return (
      <div className="space-y-3">
        <BackToDoors />
        <Alert tone="danger">{DOORS_READ_FAILED}</Alert>
        <Button variant="outline" onClick={() => void load()}>Try again</Button>
      </div>
    );
  }
  if (!row) {
    return (
      <div className="space-y-3">
        <BackToDoors />
        <p className="text-sm text-text-secondary">
          That door is not on the club's list. It may have been deleted — a board re-registers itself
          on its next heartbeat, with no name.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <BackToDoors />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 break-words text-2xl font-bold tracking-tight">{door.name}</h1>
          <DoorChips device={door} online={online} />
          <span className="sm:ml-auto">
            <DoorAge at={door.last_seen_at} now={now} prefix={online ? "Heard from" : "Last heard from"} />
          </span>
        </div>
        <p className="min-w-0 break-words text-xs text-text-muted">
          {`${door.gate_key ?? UNNAMED_GATE} · ${door.device_code}`}
        </p>
      </header>

      <Card><p className="text-sm text-text-secondary">{doorStateNotice(door, online, timezone)}</p></Card>

      <DoorSignalNotices doorName={door.name} signals={row.signals} settings={signalSettingsOf(read.settings)} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <DoorFeed
          door={door}
          today={row.today}
          read={{
            entries: read.entries, events: read.events, loading: read.feedLoading, error: read.feedError,
          }}
          clock={{ now, dayStartedAt: read.view!.day_started_at, timezone }}
        />

        <div className="space-y-6">
          <DoorCardSection
            door={door}
            settings={read.settings}
            editing={editing}
            onEdit={() => setEditing(true)}
            onClose={() => setEditing(false)}
            onSave={actions.save}
          />
          <DoorControls
            door={door}
            actions={actions}
            online={online}
            shutAt={shutAtFace(door.out_of_service_since ?? null, timezone)}
          />
        </div>
      </div>
    </div>
  );
}
